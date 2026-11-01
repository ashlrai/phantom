/**
 * Job stop — signal every process of ONE live fleet job, with an audit
 * trail. The Worker log pane POSTs the job id to
 * POST /api/verse/fleet/runs/stop, which calls stopJob here.
 *
 * Discovery reuses stray-slots.ts's StrayReaders seam (the `ps` table plus a
 * per-pid cwd), injectable so tests never spawn anything. A pid counts only
 * when the job id appears IN ITS COMMAND LINE on token boundaries — never on
 * cwd alone — so a mistyped id can never reach the verse server, dispatchd
 * or a shell that merely sits inside the worktree. Grep invocations are
 * skipped because `ps | grep RQ-PHX-X` self-matches and is not a fleet
 * process.
 *
 * Every call is audited: one JSON line in <runsDir>/queue/job-stops.jsonl
 * and, for a validated id, one LANE_HOLD row in <runsDir>/dispatch-events.log
 * (the usage-reset-release.ts row style) so the Events pane narrates the
 * stop; a refused id never lands there (untrusted text would inject pane
 * rows). The audit sink is validated BEFORE the first signal: a stop that
 * cannot be recorded must not fire. Signal errors other than ESRCH
 * propagate — an EPERM means the matched process is not ours to kill.
 */
import { constants, type Stats } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { STRAY_ID_PATTERN, defaultStrayReaders, type StrayReaders } from './stray-slots.js';

export const VERSE_FLEET_RUNS_STOP_PATH = '/api/verse/fleet/runs/stop';
export const JOB_STOPS_FILE = 'queue/job-stops.jsonl';
const DISPATCH_EVENTS_FILE = 'dispatch-events.log';
const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_BY = 'verse-operator';
/** A refused id can be arbitrary body text; bound what lands in the ledger. */
const LEDGER_ID_MAX = 200;

export type JobStopOutcome = 'stopped' | 'not-running' | 'refused';
export interface JobStopResult {
  id: string;
  /** Every pid found carrying the id (the signalled set, sorted ascending). */
  pids: number[];
  outcome: JobStopOutcome;
  at: string;
}

/** The process-table slice of stray-slots' reader seam; tests inject fakes. */
export type JobProcessReaders = Pick<StrayReaders, 'readProcesses'>;

/** Injectable clock for the TERM→KILL grace wait (see usage-reset-release). */
export interface JobStopTimers {
  set(fn: () => void, ms: number): unknown;
}

export interface StopJobOptions {
  readers?: JobProcessReaders;
  /** process.kill, injected for tests; signal 0 is the aliveness probe. */
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => unknown;
  graceMs?: number;
  timers?: JobStopTimers;
  runsDir?: string;
  now?: () => number;
  by?: string;
}

/** `ps | grep X` self-matches; a grep invocation is never a fleet process. */
const GREP_RE = /(?:^|\s)grep(?:\s|$)/;

/** The job id on token boundaries — the jobIdInCommand rule live workers use. */
function jobIdMatcher(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`);
}

/** Pids whose command line carries the job id on token boundaries, sorted
 * ascending. Command-line evidence only — cwd inside the worktree does not
 * count on its own. */
export async function findJobProcesses(id: string, readers: JobProcessReaders = defaultStrayReaders): Promise<number[]> {
  if (!STRAY_ID_PATTERN.test(id)) return [];
  const match = jobIdMatcher(id);
  const rows = await readers.readProcesses();
  const pids = new Set<number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.pid === process.pid) continue;
    if (GREP_RE.test(row.command) || !match.test(row.command)) continue;
    pids.add(row.pid);
  }
  return [...pids].sort((a, b) => a - b);
}

const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const esrch = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ESRCH';

const realTimers: JobStopTimers = { set: (fn, ms) => setTimeout(fn, ms) };

/** Append one audit line the same guarded way lane-target-changes.log is written. */
async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new Error('invalid sink');
    await handle.writeFile(line);
  } finally { await handle.close(); }
}

/** One JSON line per stop call in queue/job-stops.jsonl. */
async function appendAuditLine(runsDir: string, result: JobStopResult, by: string): Promise<void> {
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  const record = { at: result.at, id: result.id.slice(0, LEDGER_ID_MAX), pids: result.pids, outcome: result.outcome, by };
  await appendLine(join(runsDir, JOB_STOPS_FILE), `${scrubSecrets(JSON.stringify(record))}\n`);
}

/** The LANE_HOLD row the Events pane narrates. Only called for validated ids. */
function stopEventLine(result: JobStopResult, by: string): string {
  const stamp = result.at.slice(0, 19).replace('T', ' ');
  const detail = result.outcome === 'stopped'
    ? `${result.pids.length} ${result.pids.length === 1 ? 'process' : 'processes'} signalled`
    : 'no live processes';
  return `${stamp} LANE_HOLD stopped ${result.id} by ${by}: ${detail}\n`;
}

/** SIGTERM every pid carrying the job id, wait graceMs, SIGKILL survivors.
 * 'refused' = id failed the shape (nothing signalled, no events row);
 * 'not-running' = no process carried the id; 'stopped' = all matched pids
 * were signalled. */
export async function stopJob(id: string, opts: StopJobOptions = {}): Promise<JobStopResult> {
  const now = opts.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const by = opts.by ?? DEFAULT_BY;
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  if (!STRAY_ID_PATTERN.test(id)) {
    const refused: JobStopResult = { id, pids: [], outcome: 'refused', at };
    await appendAuditLine(runsDir, refused, by).catch(() => undefined);
    return refused;
  }
  const pids = await findJobProcesses(id, opts.readers ?? defaultStrayReaders);
  if (pids.length === 0) {
    const empty: JobStopResult = { id, pids, outcome: 'not-running', at };
    await appendAuditLine(runsDir, empty, by).catch(() => undefined);
    await appendLine(join(runsDir, DISPATCH_EVENTS_FILE), stopEventLine(empty, by)).catch(() => undefined);
    return empty;
  }

  // Fail closed on the audit sink before the first signal.
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  const kill = opts.kill ?? ((pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => { process.kill(pid, signal); });
  const timers = opts.timers ?? realTimers;
  for (const pid of pids) {
    try { kill(pid, 'SIGTERM'); } catch (error) { if (!esrch(error)) throw error; }
  }
  if (graceMs > 0) await new Promise<void>((resolve) => { timers.set(() => resolve(), graceMs); });
  const survivors = pids.filter((pid) => {
    try { kill(pid, 0); return true; } catch (error) { return !esrch(error); }
  });
  for (const pid of survivors) {
    try { kill(pid, 'SIGKILL'); } catch (error) { if (!esrch(error)) throw error; }
  }

  const stopped: JobStopResult = { id, pids, outcome: 'stopped', at };
  await appendAuditLine(runsDir, stopped, by);
  // Observational only — the ledger above is the audit; this line is what
  // the Events pane narrates, in the LANE_HOLD row style.
  await appendLine(join(runsDir, DISPATCH_EVENTS_FILE), stopEventLine(stopped, by)).catch(() => undefined);
  return stopped;
}
