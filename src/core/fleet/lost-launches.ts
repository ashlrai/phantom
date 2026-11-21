/**
 * lost-launches.ts — jobs that vanished at launch.
 *
 * A job is lost when metrics/jobs.jsonl has a `launch` event for it and either
 *   - its `<ID>.launch` file starts with `error:` (the launcher died, e.g. two launches fetching the shared clone), or
 *   - the launch is older than 30 minutes and no `finish` or `publish` event follows it.
 * `findLostLaunches` is pure; `readLostLaunches` is the read-only file wrapper. Nothing here writes ready.tsv.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export const LOST_LAUNCHES_SCHEMA = 'jobs.lost.v1';
export const LOST_LAUNCH_GRACE_MS = 30 * 60_000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LAUNCH_FILE_MAX = 2000;
const METRICS_TAIL_BYTES = 8 * 1024 * 1024;

export interface LostLaunch {
  job: string;
  lane: string | null;
  repo: string | null;
  /** ISO time of the launch event (the `.launch` file time when the ledger has none); null when neither is known. */
  launched_at: string | null;
  reason: string;
}
export interface LostLaunchesReport {
  schema: typeof LOST_LAUNCHES_SCHEMA;
  known: boolean;
  since_hours: number;
  count: number;
  lost: LostLaunch[];
  skipped_lines: number;
}
/** `<ID>.launch` first line, plus the file time when known. A bare string is the first line alone. */
export type LaunchHeads = Map<string, string | { line: string; at?: number }> | Record<string, string | { line: string; at?: number }>;

const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;

export function launchErrorReason(line: string): string | null {
  const text = line.trim();
  if (!/^error:/i.test(text)) return null;
  if (/cannot lock ref/i.test(text)) return 'launch failed: git ref lock race';
  return `launch failed: ${scrubSecrets(text.replace(/^error:\s*/i, '')).slice(0, 120)}`;
}

/** Newest first. Malformed lines are counted, never fatal. */
export function findLostLaunches(lines: Iterable<string>, heads: LaunchHeads | undefined, now: number, sinceHours = 24): { lost: LostLaunch[]; skipped: number } {
  const launches = new Map<string, { at: number; lane: string | null; repo: string | null }>();
  const ended = new Map<string, number>();
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { const v: unknown = JSON.parse(line); if (!v || typeof v !== 'object' || Array.isArray(v)) { skipped++; continue; } row = v as Record<string, unknown>; }
    catch { skipped++; continue; }
    const job = str(row['job']) ?? str(row['job_id']) ?? str(row['id']);
    const ts = typeof row['ts'] === 'string' ? Date.parse(row['ts']) : NaN;
    if (!job || !Number.isFinite(ts)) { skipped++; continue; }
    if (row['event'] === 'launch') {
      const prior = launches.get(job);
      if (!prior || ts >= prior.at) launches.set(job, { at: ts, lane: str(row['lane']), repo: str(row['repo']) });
    } else if (row['event'] === 'finish' || row['event'] === 'publish') ended.set(job, Math.max(ended.get(job) ?? -Infinity, ts));
  }
  const entries = heads instanceof Map ? [...heads] : Object.entries(heads ?? {});
  const failed = new Map<string, { reason: string; at?: number }>();
  for (const [job, v] of entries) {
    const reason = launchErrorReason(typeof v === 'string' ? v : v.line);
    if (reason) failed.set(job, typeof v === 'string' || v.at === undefined ? { reason } : { reason, at: v.at });
  }
  const cutoff = now - sinceHours * 3_600_000;
  const out: Array<LostLaunch & { ms: number }> = [];
  for (const job of new Set([...launches.keys(), ...failed.keys()])) {
    const launch = launches.get(job);
    const fail = failed.get(job);
    // A launch event is required for a ledger-only loss; an error file alone still counts (the ledger may be clipped).
    const at = launch?.at ?? fail?.at ?? null;
    if (at !== null && (at < cutoff || at > now)) continue;
    const done = ended.get(job);
    if (launch && done !== undefined && done >= launch.at) continue;
    let reason = fail?.reason;
    if (!reason) {
      if (!launch || now - launch.at < LOST_LAUNCH_GRACE_MS) continue;
      reason = 'launched, never finished';
    }
    out.push({ job, lane: launch?.lane ?? null, repo: launch?.repo ?? null, launched_at: at === null ? null : new Date(at).toISOString(), reason, ms: at ?? 0 });
  }
  out.sort((a, b) => b.ms - a.ms || a.job.localeCompare(b.job));
  return { lost: out.map(({ ms: _ms, ...item }) => item), skipped };
}

async function readHead(path: string, bytes: number, fromEnd = false): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('not a file');
  const handle = await open(path, 'r');
  try {
    const start = fromEnd ? Math.max(0, info.size - bytes) : 0;
    const buf = Buffer.alloc(Math.min(bytes, info.size - start));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return fromEnd && start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { await handle.close(); }
}

export interface ReadLostOptions { runsDir?: string; now?: () => number }

/** Reads the ledger tail and the recent `<ID>.launch` files under the runs dir. `known` is false when jobs.jsonl is unreadable. */
export async function readLostLaunches(sinceHours = 24, opts: ReadLostOptions = {}): Promise<LostLaunchesReport> {
  const now = (opts.now ?? Date.now)();
  const runsDir = resolve(opts.runsDir ?? (process.env['ASHLR_RUNS_DIR']?.trim() || join(homedir(), '.ashlr-runs')));
  let ledger: string | null = null;
  try { ledger = await readHead(join(runsDir, 'metrics', 'jobs.jsonl'), METRICS_TAIL_BYTES, true); } catch { /* unknown below */ }
  const heads = new Map<string, { line: string; at: number }>();
  try {
    const names = (await readdir(runsDir)).filter(n => n.endsWith('.launch') && JOB_ID.test(n.slice(0, -7)));
    const stats = (await Promise.all(names.map(async name => {
      try { const s = await lstat(join(runsDir, name)); return s.isFile() && s.mtimeMs >= now - sinceHours * 3_600_000 ? { name, at: s.mtimeMs } : null; }
      catch { return null; }
    }))).filter((s): s is { name: string; at: number } => s !== null).sort((a, b) => b.at - a.at).slice(0, LAUNCH_FILE_MAX);
    await Promise.all(stats.map(async ({ name, at }) => {
      try { heads.set(name.slice(0, -7), { line: (await readHead(join(runsDir, name), 4096)).split(/\r?\n/).find(l => l.trim()) ?? '', at }); }
      catch { /* an unreadable record is not evidence */ }
    }));
  } catch { /* no runs dir: the ledger read already says unknown */ }
  if (ledger === null) return { schema: LOST_LAUNCHES_SCHEMA, known: false, since_hours: sinceHours, count: 0, lost: [], skipped_lines: 0 };
  const { lost, skipped } = findLostLaunches(ledger.split(/\r?\n/), heads, now, sinceHours);
  return { schema: LOST_LAUNCHES_SCHEMA, known: true, since_hours: sinceHours, count: lost.length, lost, skipped_lines: skipped };
}

/** The ready.tsv row an operator would re-add: id, repo, lane (tab separated). Never written by this code. */
export function requeueHint(item: LostLaunch): string {
  return `${item.job}\t${item.repo ?? '<repo>'}\t${item.lane ?? '<lane>'}`;
}

const when = (item: LostLaunch) => item.launched_at ?? 'unknown time';
export function lostLaunchesLines(report: LostLaunchesReport, hint = false): string[] {
  if (!report.known) return ['Lost launches: unknown. The job metrics file cannot be read.'];
  const n = report.count;
  const lines = [n ? `${n} lost ${n === 1 ? 'launch' : 'launches'} in the last ${report.since_hours} h` : `No lost launches in the last ${report.since_hours} h.`];
  for (const item of report.lost) lines.push(`  ${item.job} (${item.lane ?? 'unknown lane'}) ${when(item)}: ${item.reason}`);
  if (hint && n) lines.push('Re-add to queue/ready.tsv if the work is still wanted (not written for you):', ...report.lost.map(requeueHint));
  return lines;
}
