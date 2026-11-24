/**
 * supply-doctor.ts — `phm doctor supply`: is self-supply landing jobs?
 *
 * Reads three things under the runs dir and never writes:
 *   - leader/drop/ingested.tsv  (time, id, source, lane, tier, first line): what the host ingest accepted;
 *   - leader/drop/done/         (RQ-PHX-<id>.md.<reason>): what it rejected, with the reason in the name;
 *   - the live config           (autofill.off): the switch the self-tick gap hook obeys.
 *
 * WHY THE SOURCE IS DERIVED: the ingest's third column is the drop sub-directory a file came from. The gap
 * writer must publish into leader/drop/claude (the only directory the ingest sweeps for RQ-PHX jobs), so its
 * rows read "claude", the same as every other Claude drop. Gap jobs are told apart by their id: gapJobId()
 * always makes `GAP` + 10 hex digits. A row whose id starts RQ-PHX-GAP is reported as source "gap".
 *
 * Anything unreadable is "unknown" with the path named; nothing is guessed.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LostLaunch } from './lost-launches.js';
import { liveStatePath } from './build-last.js';
import { readBuildLive, type BuildLiveReport } from './build-live.js';
import { readSelfTickStatus, type SelfTickStatus } from './self-tick-status.js';
import { readDispatchEventsLog } from './dispatch-events-read.js';
import { computeLanesHeld, type LaneHeldRow } from './lane-held.js';
import { parseDoneName, parseIngestedTsv } from './drop-job-fate.js';
import { readGapProposals } from './gap-proposal-record.js';

export const SUPPLY_DOCTOR_SCHEMA = 'doctor.supply.v1';
/** The prefix gapJobId() gives every gap job id (after RQ-PHX-). */
export const GAP_JOB_ID_PREFIX = 'GAP';
const DAY_MS = 24 * 3_600_000;
/** Read at most this much of the end of ingested.tsv (rows are ~200 bytes; this is ~5000 rows). */
const TAIL_BYTES = 1024 * 1024;
const MAX_DONE_ENTRIES = 5000;

type Known<T> = { state: 'known'; path: string } & T;
type Unknown = { state: 'unknown'; path: string; why: string };

export interface SupplySource { source: string; lastIngest: string; count24h: number }
export interface SupplyDoctorReport {
  schema: typeof SUPPLY_DOCTOR_SCHEMA;
  generatedAt: string;
  runsDir: string;
  /** Per source in ingested.tsv, newest first by last ingest. Local time of the host, as the ingest wrote it. */
  ingested: Known<{ sources: SupplySource[] }> | Unknown;
  /** Rejected drops (leader/drop/done) in the last 24 h, by reason. */
  rejected: Known<{ total24h: number; byReason: Record<string, number> }> | Unknown;
  /** The self-tick gap hook runs under autofill: on unless `autofill.off` is set; null when unreadable. */
  hook: { enabled: boolean | null; switch: 'autofill.off'; note: string };
  /** Gap jobs the ingest accepted in 24 h; null when ingested.tsv is unreadable. */
  selfSupply: { landed24h: number | null; lastLanded: string | null };
  /** Gap jobs in 24 h; each count is null (unknown) when its source cannot be read: proposed (metrics/gap-proposed.jsonl), ingested (gap rows of ingested.tsv), launched (an ingested gap with an RQ-PHX-<id>.prompt in the runs dir). */
  selfSupplyToday: { proposed: number | null; ingested: number | null; launched: number | null; line: string };
  /** Gap candidates the finder would queue now (24 h, after de-duplication), by source; unknown when the job metrics cannot be read. */
  candidates: { state: 'known'; noChange: number; published: number } | { state: 'unknown'; why: string };
  /** Jobs that launched in 24 h and vanished (no finish or publish, or a failed launch); newest 5. Unknown when the job metrics cannot be read. */
  lost_launches: { state: 'known'; count: number; newest: LostLaunch[] } | { state: 'unknown'; why: string };
  /** Lanes whose own wrapper held every launch in the last 60 min (3+ held, 0 finishes); unknown when the event log is unreadable. */
  selfHeld: { state: 'known'; windowMinutes: number; lanes: LaneHeldRow[] } | { state: 'unknown'; why: string };
  /** Why EMPTY jobs stopped in 24 h (same reasons as `phm jobs empty`); top is null when none or only unknown. Unknown when the job metrics cannot be read. */
  empty: { state: 'known'; total: number; top: { reason: string; count: number } | null } | { state: 'unknown'; why: string };
  /** Is the running phm the merged code? Same report as `phm doctor build --json`. */
  build: BuildLiveReport;
  /** When the self-tick last ran and what its hooks produced. Same report as `phm fleet self-tick --status --json`. */
  selfTick: SelfTickStatus;
  verdict: string;
}

export interface SupplyDoctorOptions {
  /** EMPTY jobs in 24 h by final reason; null when unreadable. Defaults to the empty-job reader. */
  readEmpty?: (runsDir: string, nowMs: number) => Promise<{ total: number; reasons: Record<string, number> } | null>;
  runsDir?: string;
  now?: () => number;
  /** true = autofill off, false = on, null = unreadable. Defaults to the live config. */
  readOff?: (runsDir: string) => Promise<boolean | null>;
  /** Candidate counts by source. Defaults to the gap finder (read only, no propose). */
  /** Dispatch event log text (null = unreadable). Defaults to the runs-dir log. */
  readEvents?: (runsDir: string) => Promise<string | null>;
  readCandidates?: (runsDir: string) => Promise<{ noChange: number; published: number } | null>;
  /** Lost launches in 24 h, newest first. Defaults to the lost-launch finder; null when unreadable. */
  /** Seams for the build and self-tick lines; default to the real readers. */
  readBuild?: () => BuildLiveReport;
  readSelfTick?: (runsDir: string, nowMs: number) => SelfTickStatus;
  readLost?: (runsDir: string, nowMs: number) => Promise<LostLaunch[] | null>;
}

const errText = (e: unknown): string => (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';

export function ingestRowSource(id: string, pass: string): string {
  if (id.startsWith(`RQ-PHX-${GAP_JOB_ID_PREFIX}`)) return 'gap';
  return pass.trim() || 'unknown';
}

async function readTail(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('not a file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // A cut first line is partial: drop it.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await handle.close(); }
}

async function readIngested(path: string, nowMs: number): Promise<SupplyDoctorReport['ingested']> {
  let text: string;
  try { text = await readTail(path); } catch (e) { return { state: 'unknown', path, why: errText(e) }; }
  const by = new Map<string, { last: number; lastText: string; count: number }>();
  for (const row of parseIngestedTsv(text)) {
    const at = Date.parse(row.at.replace(' ', 'T'));
    const source = ingestRowSource(row.id, row.pass);
    const entry = by.get(source) ?? { last: -Infinity, lastText: '', count: 0 };
    if (at > entry.last) { entry.last = at; entry.lastText = row.at; }
    if (nowMs - at >= 0 && nowMs - at < DAY_MS) entry.count++;
    by.set(source, entry);
  }
  const sources = [...by.entries()]
    .sort((a, b) => b[1].last - a[1].last || a[0].localeCompare(b[0]))
    .map(([source, e]) => ({ source, lastIngest: e.lastText, count24h: e.count }));
  return { state: 'known', path, sources };
}

/** The ids of gap rows ingested in 24 h; null when ingested.tsv is unreadable. */
async function readIngestedGapIds(path: string, nowMs: number): Promise<string[] | null> {
  let text: string;
  try { text = await readTail(path); } catch { return null; }
  const ids = new Set<string>();
  for (const row of parseIngestedTsv(text)) {
    const age = nowMs - Date.parse(row.at.replace(' ', 'T'));
    if (row.id.startsWith(`RQ-PHX-${GAP_JOB_ID_PREFIX}`) && age >= 0 && age < DAY_MS) ids.add(row.id);
  }
  return [...ids];
}

/** "Self-supply today: 3 proposed, 2 ingested, 1 launched"; an unreadable count says unknown. */
export async function readSelfSupplyToday(runsDir: string, nowMs: number): Promise<SupplyDoctorReport['selfSupplyToday']> {
  const [record, gapIds] = await Promise.all([
    readGapProposals(runsDir, nowMs),
    readIngestedGapIds(join(runsDir, 'leader', 'drop', 'ingested.tsv'), nowMs),
  ]);
  const proposed = record.state === 'known' ? new Set(record.proposals.map(p => p.id)).size : null;
  // A launched job leaves <runsDir>/RQ-PHX-<id>.prompt (see drop-job-writer.ts).
  const launched = gapIds === null ? null
    : (await Promise.all(gapIds.map(id => lstat(join(runsDir, `${id}.prompt`)).then(() => 1, () => 0)))).reduce<number>((a, b) => a + b, 0);
  const n = (v: number | null): string => v === null ? 'unknown' : String(v);
  const ingested = gapIds === null ? null : gapIds.length;
  return { proposed, ingested, launched, line: `Self-supply today: ${n(proposed)} proposed, ${n(ingested)} ingested, ${n(launched)} launched` };
}

async function readRejected(dir: string, nowMs: number): Promise<SupplyDoctorReport['rejected']> {
  let names: string[];
  try { names = (await readdir(dir)).slice(0, MAX_DONE_ENTRIES); } catch (e) { return { state: 'unknown', path: dir, why: errText(e) }; }
  const byReason: Record<string, number> = {};
  let total24h = 0;
  for (const name of names) {
    const parsed = parseDoneName(name);
    if (!parsed) continue;
    try {
      const stat = await lstat(join(dir, name));
      if (!stat.isFile() || nowMs - stat.mtimeMs >= DAY_MS || nowMs < stat.mtimeMs) continue;
    } catch { continue; }
    byReason[parsed.reason] = (byReason[parsed.reason] ?? 0) + 1;
    total24h++;
  }
  return { state: 'known', path: dir, total24h, byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => a.localeCompare(b))) };
}

function verdictOf(report: Pick<SupplyDoctorReport, 'ingested' | 'selfSupply' | 'hook' | 'lost_launches' | 'empty'>): string {
  const top = report.empty.state === 'known' ? report.empty.top : null;
  const empty = top ? `; top EMPTY reason in 24 h: ${top.reason} (${top.count} of ${(report.empty as { total: number }).total})` : '';
  const lost = report.lost_launches.state === 'known' && report.lost_launches.count > 0
    ? `; ${report.lost_launches.count} ${report.lost_launches.count === 1 ? 'job' : 'jobs'} lost at launch in 24 h` : '';
  return supplyVerdict(report) + lost + empty;
}

function supplyVerdict(report: Pick<SupplyDoctorReport, 'ingested' | 'selfSupply' | 'hook'>): string {
  if (report.ingested.state === 'unknown') return `self-supply is unknown: cannot read ${report.ingested.path} (${report.ingested.why})`;
  const { landed24h, lastLanded } = report.selfSupply;
  if (landed24h) return `self-supply landed ${landed24h} ${landed24h === 1 ? 'job' : 'jobs'} in 24 h (last ${lastLanded})`;
  const why = report.hook.enabled === false ? '; the self-tick gap hook is off (autofill.off is set)'
    : report.hook.enabled === null ? '; the self-tick gap hook state is unknown' : '';
  return `self-supply has not landed a job in 24 h${why}`;
}

export async function readSupplyDoctor(opts: SupplyDoctorOptions = {}): Promise<SupplyDoctorReport> {
  const nowMs = (opts.now ?? Date.now)();
  const runsDir = resolve(opts.runsDir ?? (process.env['ASHLR_RUNS_DIR']?.trim() || join(homedir(), '.ashlr-runs')));
  const readOff = opts.readOff ?? (async (dir: string) => (await import('./autofill-run.js')).readAutofillOff(dir));
  const readCandidates = opts.readCandidates ?? (async (dir: string) => {
    const gaps = await (await import('./job-gaps.js')).readJobGaps(24, { runsDir: dir });
    return gaps.known ? { noChange: gaps.bySource['no-change'], published: gaps.bySource.published } : null;
  });
  const readLost = opts.readLost ?? (async (dir: string, at: number) => {
    const r = await (await import('./lost-launches.js')).readLostLaunches(24, { runsDir: dir, now: () => at });
    return r.known ? r.lost : null;
  });
  const readEvents = opts.readEvents ?? readDispatchEventsLog;
  const readEmpty = opts.readEmpty ?? (async (dir: string, at: number) => {
    const r = await (await import('./empty-jobs.js')).readEmptyJobs(24, dir, undefined, at);
    return r?.final ? { total: r.total, reasons: r.final.reasons } : null;
  });
  const [ingested, rejected, off, found, lost, events, emptyRead, selfSupplyToday] = await Promise.all([
    readIngested(join(runsDir, 'leader', 'drop', 'ingested.tsv'), nowMs),
    readRejected(join(runsDir, 'leader', 'drop', 'done'), nowMs),
    readOff(runsDir).catch(() => null),
    readCandidates(runsDir).catch(() => null),
    readLost(runsDir, nowMs).catch(() => null),
    readEvents(runsDir).catch(() => null),
    readEmpty(runsDir, nowMs).catch(() => null),
    readSelfSupplyToday(runsDir, nowMs),
  ]);
  // Real reasons outrank unknown: a lone unknown pile is not a reason.
  const topEmpty = emptyRead ? Object.entries(emptyRead.reasons).filter(([r, n]) => r !== 'unknown' && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] : undefined;
  const held = computeLanesHeld(events, nowMs);
  const gap = ingested.state === 'known' ? ingested.sources.find(s => s.source === 'gap') : undefined;
  const selfSupply = {
    landed24h: ingested.state === 'known' ? gap?.count24h ?? 0 : null,
    lastLanded: gap?.lastIngest ?? null,
  };
  const hook = {
    enabled: off === null ? null : !off,
    switch: 'autofill.off' as const,
    note: 'Runs once per self-tick when a lane is starved, applying, and autofill is on.',
  };
  const report = { schema: SUPPLY_DOCTOR_SCHEMA, generatedAt: new Date(nowMs).toISOString(), runsDir, ingested, rejected, hook, selfSupply, selfSupplyToday,
    selfHeld: held.source === 'ok'
      ? { state: 'known', windowMinutes: held.windowMinutes, lanes: held.lanes.filter(r => r.selfHeld) }
      : { state: 'unknown', why: 'dispatch event log unreadable' },
    candidates: found ? { state: 'known', ...found } : { state: 'unknown', why: 'job metrics unreadable' },
    empty: emptyRead ? { state: 'known', total: emptyRead.total, top: topEmpty ? { reason: topEmpty[0], count: topEmpty[1] } : null } : { state: 'unknown', why: 'job metrics unreadable' },
    build: (opts.readBuild ?? (() => readBuildLive({ liveStatePath: liveStatePath(runsDir) })))(),
    selfTick: (opts.readSelfTick ?? readSelfTickStatus)(runsDir, nowMs),
    lost_launches: lost ? { state: 'known', count: lost.length, newest: lost.slice(0, 5) } : { state: 'unknown', why: 'job metrics unreadable' } } as SupplyDoctorReport;
  report.verdict = verdictOf(report);
  return report;
}

/** Plain words: the verdict first, then one line per source, then rejects and the hook. */
export function supplyDoctorLines(report: SupplyDoctorReport): string[] {
  const lines = [report.verdict, report.selfSupplyToday.line + '.'];
  if (report.ingested.state === 'known') {
    if (!report.ingested.sources.length) lines.push(`No jobs in ${report.ingested.path} yet.`);
    for (const s of report.ingested.sources) lines.push(`  ${s.source}: last ingest ${s.lastIngest}, ${s.count24h} in 24 h`);
  }
  if (report.rejected.state === 'unknown') lines.push(`Rejected drops: unknown (${report.rejected.path} is ${report.rejected.why}).`);
  else {
    const reasons = Object.entries(report.rejected.byReason).map(([reason, n]) => `${reason} ${n}`).join(', ');
    lines.push(`Rejected drops in 24 h: ${report.rejected.total24h}${reasons ? ` (${reasons})` : ''}.`);
  }
  lines.push(report.candidates.state === 'known'
    ? `Gap candidates now: ${report.candidates.noChange} from no-change jobs, ${report.candidates.published} from published jobs.`
    : `Gap candidates now: unknown (${report.candidates.why}).`);
  if (report.lost_launches.state === 'unknown') lines.push(`Lost launches: unknown (${report.lost_launches.why}).`);
  else if (report.lost_launches.count) {
    lines.push(`Lost launches in 24 h: ${report.lost_launches.count} (newest ${report.lost_launches.newest.length}; see "phm jobs lost").`);
    for (const l of report.lost_launches.newest) lines.push(`  ${l.job} (${l.lane ?? 'unknown lane'}): ${l.reason}`);
  } else lines.push('Lost launches in 24 h: 0.');
  if (report.selfHeld.state === 'unknown') lines.push(`Self-held lanes: unknown (${report.selfHeld.why}).`);
  else if (!report.selfHeld.lanes.length) lines.push('Self-held lanes: none.');
  else for (const r of report.selfHeld.lanes) lines.push(`Self-held lane: ${r.reason}; skipped until a launch there finishes.`);
  if (report.empty.state === 'unknown') lines.push(`EMPTY jobs: unknown (${report.empty.why}).`);
  else lines.push(`EMPTY jobs in 24 h: ${report.empty.total}${report.empty.top ? `, most often ${report.empty.top.reason} (${report.empty.top.count}); see "phm jobs empty"` : ''}.`);
  lines.push(`Live build: ${report.build.verdict}.`);
  lines.push(`Self-tick: ${report.selfTick.line}.`);
  lines.push(`Self-tick gap hook: ${report.hook.enabled === null ? 'unknown' : report.hook.enabled ? 'on' : 'off'}.`);
  return lines;
}
