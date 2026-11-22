/**
 * Recut gate: should a recut or red-fix job be written at all?
 *
 * Recut families (RQ-PHX-RECUT<AREA>C<NNN>, RQ-PHX-REDTYPEFIXC<NNN>, ...) kept
 * launching after master already held the work, so each run ended EMPTY. This
 * gate answers from plain local facts before a generator writes a job:
 *   (a) the job kind is on the `phm jobs yield --stop-list` list,
 *   (b) the last N jobs of the same kind ended EMPTY and master has no new
 *       commits touching that area since,
 *   (c) the source ref is already contained in master,
 *   (d) a live row in the job stop file (`stop-file.ts`) matches the job id or its kind.
 * Missing facts never skip: unknown yield emits with reason "yield unknown".
 *
 * `shouldEmitRecut` is pure. `readRecutGateFacts` does the reading, reusing the
 * job-yield tally (`slot-yield.ts`) so the stop list is the one `phm jobs yield` prints.
 */
import { execFile } from 'node:child_process';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { ledgerAtMs, ledgerEventName, ledgerJobId } from './empty-cause.js';
import { jobKind, yieldTally } from './slot-yield.js';
import { launchFamily, readFamilyYield, shouldPauseFamily, type LaunchFamilyYield } from './family-yield.js';
import { readLiveStops, stopFilePath, stoppedBy } from './stop-file.js';

export const RECUT_EMPTY_STREAK = 3;
export const RECUT_CHECK_SCHEMA = 'recut.check.v1';

export interface RecutLastJob { job: string; empty: boolean; ended_at: string }

export interface RecutGateInput {
  /** Job kind, e.g. RQ-PHX-RECUTCORE. */
  family: string;
  /** Kinds with a stop verdict; null when the yield ledger was unreadable. */
  stopList: readonly string[] | null;
  /** Newest first, ended jobs of the same kind. */
  lastJobs: readonly RecutLastJob[];
  /** Master has commits in the area since the newest job started; null when unknown. */
  masterTouched: boolean | null;
  /** The source ref adds nothing to master; null when no ref was given or git could not tell. */
  diffContained: boolean | null;
  /** The live stop-file row that matches this job or kind; null or absent when none does or the file is unknown. */
  stopRow?: { until: number; reason: string } | null;
  streak?: number;
  yieldStats?: LaunchFamilyYield;
}

export type RecutGateCode = 'already-on-master' | 'stop-file' | 'yield-unknown' | 'stop-list' | 'empty-streak' | 'family-paused' | 'emit';
export interface RecutGateDecision { emit: boolean; code: RecutGateCode; reason: string }

export function shouldEmitRecut(input: RecutGateInput): RecutGateDecision {
  const n = input.streak ?? RECUT_EMPTY_STREAK;
  if (shouldPauseFamily(input.yieldStats)) return { emit: false, code: 'family-paused', reason: 'recent workers found no source or made no changes' };
  if (input.diffContained === true) return { emit: false, code: 'already-on-master', reason: 'the source change is already on master' };
  if (input.stopRow) {
    return { emit: false, code: 'stop-file', reason: `${input.family} is stopped by the stop file until ${new Date(input.stopRow.until * 1000).toISOString()}${input.stopRow.reason ? ` (${input.stopRow.reason})` : ''}` };
  }
  if (input.stopList === null) return { emit: true, code: 'yield-unknown', reason: 'yield unknown' };
  if (input.stopList.includes(input.family)) return { emit: false, code: 'stop-list', reason: `${input.family} is on the yield stop list` };
  const last = input.lastJobs.slice(0, n);
  if (last.length >= n && last.every(job => job.empty)) {
    if (input.masterTouched === false) {
      return { emit: false, code: 'empty-streak', reason: `the last ${n} ${input.family} jobs ended empty and master has not changed in this area since` };
    }
    return { emit: true, code: 'emit', reason: input.masterTouched === null
      ? `the last ${n} ${input.family} jobs ended empty, but whether master changed since is unknown`
      : `master changed in this area since the last ${n} empty ${input.family} jobs` };
  }
  return { emit: true, code: 'emit', reason: 'no skip rule matched' };
}

/** The repo paths a recut area covers. An area missing here counts every path, which can only emit more. */
export const AREA_PATHS: Readonly<Record<string, readonly string[]>> = {
  CORE: ['src/core'], COREFLEET: ['src/core/fleet'], FLEETCLI: ['src/cli'], CLI: ['src/cli'], MCP: ['src/mcp'],
  WEBUI: ['src/web-ui'], DESK: ['src/web-ui', 'desktop'], VERSE: ['src/core/verse', 'src/web-ui/routes/verse'],
  COMMS: ['src/core/comms'], TESTONLY: ['test'], DOCS: ['docs'], SCRIPTS: ['scripts'], SRC: ['src'],
};
const KIND_PREFIX = /^(?:RQ-)?(?:PHX-)?(RECUT|RED(?:TYPE|TEST)?FIX)/;

/** The recut areas the generator cycles through, in a fixed order. */
export const RECUT_AREAS: readonly string[] = Object.keys(AREA_PATHS);

/** `core`, `RQ-PHX-RECUTCORE` or `RQ-PHX-RECUTCOREC566` -> family RQ-PHX-RECUTCORE, area CORE, paths [src/core]. */
export function recutTarget(arg: string): { family: string; area: string; paths: string[] } | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(arg)) return null;
  const family = /^RQ-/i.test(arg) ? jobKind(arg.toUpperCase()) : `RQ-PHX-RECUT${arg.toUpperCase().replace(/-/g, '')}`;
  const prefix = KIND_PREFIX.exec(family.replace(/^RQ-/, ''));
  const area = prefix ? family.replace(/^RQ-/, '').replace(/^PHX-/, '').slice(prefix[1]!.length) : '';
  return { family, area, paths: [...(AREA_PATHS[area] ?? [])] };
}

export type GitRun = (args: readonly string[]) => Promise<{ code: number | null; stdout: string }>;
export const runGit = (cwd: string): GitRun => args => new Promise(resolve => {
  execFile('git', [...args], { cwd, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout) }));
});

const REF = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;

/** True: no change past base; false: something left; null: git could not tell. */
export async function refContained(git: GitRun, base: string, ref: string): Promise<boolean | null> {
  if (!REF.test(base) || !REF.test(ref)) return null;
  const diff = await git(['diff', '--quiet', `${base}...${ref}`, '--']);
  if (diff.code === 0) return true;
  if (diff.code !== 1) return null;
  // Every hunk already applied: merging the ref into base leaves base's tree unchanged.
  const [merged, tree] = await Promise.all([git(['merge-tree', '--write-tree', base, ref]), git(['rev-parse', `${base}^{tree}`])]);
  if (merged.code === 1) return false;
  if (merged.code !== 0 || tree.code !== 0) return null;
  return merged.stdout.split('\n')[0]!.trim() === tree.stdout.trim();
}

export interface RecutGateFacts extends RecutGateInput { area: string; paths: string[]; ref: string | null; since: string | null }
export interface RecutGateReadOptions {
  metrics: string; git: GitRun; now?: number; base?: string; ref?: string | null;
  streak?: number; read?: YieldLineReader;
  /** Stop file path; defaults to the configured one. Null or unreadable means no stop-file fact. */
  stopFile?: string | null;
}

/** One pass over jobs.jsonl, then at most three git calls. Never throws; unreadable facts become null. */
export async function readRecutGateFacts(target: string, opts: RecutGateReadOptions): Promise<RecutGateFacts | null> {
  const t = recutTarget(target);
  if (!t) return null;
  const now = opts.now ?? Date.now(), base = opts.base ?? 'master', n = opts.streak ?? RECUT_EMPTY_STREAK;
  const tally = yieldTally(now, 24);
  const launched = new Map<string, number>(), ended = new Map<string, { empty: boolean; at: number }>();
  const known = await (opts.read ?? readLedgerLines)(opts.metrics, line => {
    tally.add(line);
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      row = value as Record<string, unknown>;
    } catch { return; }
    const job = ledgerJobId(row), at = ledgerAtMs(row);
    if (job === null || at === null) return;
    if (jobKind(job, typeof row.repo === 'string' ? row.repo : undefined) !== t.family) return;
    const event = ledgerEventName(row);
    if (event === 'launch') launched.set(job, Math.max(launched.get(job) ?? 0, at));
    if (event === 'finish' && at >= (ended.get(job)?.at ?? 0)) ended.set(job, { empty: row.empty === true, at });
  }).catch(() => false);
  const stopList = known ? tally.jobYield().families.filter(row => row.verdict === 'stop').map(row => row.family) : null;
  const lastJobs = [...ended].sort((a, b) => b[1].at - a[1].at).slice(0, n)
    .map(([job, end]) => ({ job, empty: end.empty, ended_at: new Date(end.at).toISOString() }));
  let masterTouched: boolean | null = null, since: string | null = null;
  if (lastJobs.length >= n && lastJobs.every(job => job.empty) && REF.test(base)) {
    const newest = lastJobs[0]!;
    since = new Date(launched.get(newest.job) ?? Date.parse(newest.ended_at)).toISOString();
    const log = await opts.git(['log', '-1', '--format=%H', `--since=${since}`, base, '--', ...t.paths]);
    masterTouched = log.code === 0 ? log.stdout.trim() !== '' : null;
  }
  const ref = opts.ref ?? null;
  const diffContained = ref ? await refContained(opts.git, base, ref) : null;
  const stops = await readLiveStops(opts.stopFile === undefined ? stopFilePath() : opts.stopFile, now);
  const hit = stops && stoppedBy(stops, [target.toUpperCase(), t.family]);
  const report = await readFamilyYield(opts.metrics, 24, now, opts.read);
  return { family: t.family, area: t.area, paths: t.paths, stopList, lastJobs, masterTouched, diffContained, ref, since, streak: n,
    yieldStats: report.launch_families.find(row => row.family === launchFamily(target.toUpperCase()) || row.family === `${t.family}C`),
    stopRow: hit ? { until: hit.until, reason: hit.reason } : null };
}
