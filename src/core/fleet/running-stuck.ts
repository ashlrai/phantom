/**
 * running-stuck.ts — running jobs that are not really running (`phm jobs stuck`, jobs.stuck.v1).
 *
 * A job counts as running while queue/run/<J>.line exists and queue/run/<J>.fin does not
 * (the dispatchd marker rule in runs-sessions.ts). It is
 *   - a "ghost" when the pid in <J>.launch is gone: nothing is left to stop, only the marker lies;
 *   - "stuck" when it started more than 90 min ago and <J>.log has not grown for 30 min.
 * `classifyRunning` is pure. `readRunningJobs` reads markers only. `closeGhost` and `stopStuck`
 * are the only writers/signallers and run from stray-stop in apply mode, never from the read verb.
 */
import { lstat, open, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { stopJob, appendLine, type JobStopResult, type StopJobOptions } from './job-stop.js';
import { STRAY_ID_PATTERN, defaultStrayReaders, type StrayProcess, type StrayReaders } from './stray-slots.js';

export const STUCK_JOBS_SCHEMA = 'jobs.stuck.v1';
export const STUCK_AFTER_START_MS = 90 * 60_000;
export const STUCK_LOG_QUIET_MS = 30 * 60_000;
/** A pid that vanished seconds after launch is a launch in flight, not a ghost. */
export const GHOST_GRACE_MS = 5 * 60_000;
/** Most stuck jobs stopped per tick; ghosts are only marker writes and are not capped this tightly. */
export const MAX_STUCK_STOPS_PER_TICK = 4;
export const MAX_GHOST_CLOSES_PER_TICK = 50;
export const STUCK_STOP_GRACE_MS = 60_000;
const MARKER_BYTES = 4096;
const STUCK_LEDGER = 'queue/stuck-jobs.jsonl';

export interface RunningJob {
  job: string;
  lane: string;
  repo?: string;
  /** Epoch ms of the start (.dispatched, else the .launch file time); null when unknown. */
  startedMs: number | null;
  /** Epoch ms of the last log write; null when there is no log. */
  logMtimeMs: number | null;
  outputMtimeMs?: number | null;
  markerMtimeMs?: number | null;
  /** Pid recorded in <J>.launch; null when none is recorded. */
  pid: number | null;
  /** Epoch seconds of the .base file, the key a closing .fin carries; null when absent. */
  baseKey: string | null;
}
export type StuckKind = 'ghost' | 'stuck';
export interface StuckJob {
  job: string; lane: string; kind: StuckKind;
  age_min: number | null; last_log_at: string | null; why: string;
  /** Present for ghosts and stuck jobs alike so the caller can act without re-reading. */
  pid: number | null;
}
export interface StuckJobsReport {
  schema: typeof STUCK_JOBS_SCHEMA;
  generated_at: string;
  /** False when the run markers could not be read: nothing can be said, not "all fine". */
  known: boolean;
  running: number;
  stuck: StuckJob[];
}

const mins = (ms: number) => Math.max(0, Math.floor(ms / 60_000));
const human = (m: number) => m >= 120 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;

/** Pure: which running jobs are ghosts or stuck. `alive` answers whether a pid still exists. */
export function classifyRunning(jobs: readonly RunningJob[], now: number, alive: (pid: number) => boolean): StuckJob[] {
  const out: StuckJob[] = [];
  for (const j of jobs) {
    const age = j.startedMs === null ? null : now - j.startedMs;
    const lastLog = j.logMtimeMs === null ? null : new Date(j.logMtimeMs).toISOString();
    const base = { job: j.job, lane: j.lane, age_min: age === null ? null : mins(age), last_log_at: lastLog, pid: j.pid };
    if (j.pid !== null && (age === null || age > GHOST_GRACE_MS) && !alive(j.pid)) {
      out.push({ ...base, kind: 'ghost', why: `its process (pid ${j.pid}) is gone but the run marker is still open` });
      continue;
    }
    if (age === null || age <= STUCK_AFTER_START_MS) continue;
    const quiet = j.logMtimeMs === null ? age : now - j.logMtimeMs;
    if (quiet > STUCK_LOG_QUIET_MS) {
      out.push({ ...base, kind: 'stuck', why: j.logMtimeMs === null ? `no log after ${human(mins(age))}` : `log silent for ${human(mins(quiet))}` });
    }
  }
  return out;
}

/** One plain line: id, lane, age, last log line time, why. */
export function stuckLine(s: StuckJob): string {
  return `${s.job} ${s.lane} age ${s.age_min === null ? 'unknown' : human(s.age_min)} last-log ${s.last_log_at ?? 'none'} ${s.kind.toUpperCase()}: ${s.why}`;
}

async function smallText(path: string): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile()) return null;
    const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buf = Buffer.alloc(Math.min(st.size, MARKER_BYTES));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return null; }
}
const mtime = async (path: string): Promise<number | null> => {
  try { const st = await lstat(path); return st.isFile() ? st.mtimeMs : null; } catch { return null; }
};

/** Running jobs from queue/run markers. Throws when the marker directory cannot be listed. */
export async function readRunningJobs(runsDir: string, laneFilter?: string, includeBases = false): Promise<RunningJob[]> {
  const runDir = join(runsDir, 'queue', 'run');
  const names = await readdir(runDir);
  const lines = [...new Set([...names.filter(n => n.endsWith('.line')).map(n => n.slice(0, -5)),
    ...(includeBases ? (await readdir(runsDir)).filter(n => n.endsWith('.base')).map(n => n.slice(0, -5)) : [])])].filter(j => STRAY_ID_PATTERN.test(j));
  const finished = new Set(names.filter(n => n.endsWith('.fin')).map(n => n.slice(0, -4)));
  const jobs: RunningJob[] = [];
  for (const job of lines) {
    if (includeBases && names.includes(`${job}.reaping`)) continue;
    const baseMs = await mtime(join(runsDir, `${job}.base`));
    const baseKey = baseMs === null ? null : String(Math.floor(baseMs / 1000));
    if (finished.has(job)) {
      // A .fin keyed to another attempt's .base does not close this one (dispatchd rule).
      const key = (await smallText(join(runDir, `${job}.fin`)))?.trim() ?? '';
      if (baseKey === null || key === baseKey) continue;
    }
    const line = await smallText(join(runDir, `${job}.line`));
    const rawLane = line?.split('\t')[2]?.trim() ?? (includeBases ? (await smallText(join(runsDir, `${job}.base`)))?.trim().split(/\s+/)[3] : '') ?? '';
    const lane = STRAY_ID_PATTERN.test(rawLane) ? rawLane : 'unknown';
    if (laneFilter && lane !== laneFilter) continue;
    const repo = line?.split('\t')[1]?.trim() ?? '';
    const dispatched = Number((await smallText(join(runDir, `${job}.dispatched`)))?.trim());
    const launchMs = await mtime(join(runsDir, `${job}.launch`));
    const pidMatch = /\bpid\s+(\d+)\b/.exec((await smallText(join(runsDir, `${job}.launch`))) ?? '');
    jobs.push({
      job, lane, repo: /^[\w./-]{1,120}$/.test(repo) ? scrubSecrets(repo) : 'unknown',
      startedMs: Number.isFinite(dispatched) && dispatched > 0 ? dispatched * 1000 : launchMs,
      logMtimeMs: await mtime(join(runsDir, `${job}.log`)),
      outputMtimeMs: launchMs,
      markerMtimeMs: baseMs ?? await mtime(join(runDir, `${job}.line`)),
      pid: pidMatch ? Number(pidMatch[1]) : null,
      baseKey,
    });
  }
  return jobs;
}

export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export interface StuckReadOptions { runsDir?: string; lane?: string; now?: () => number; alive?: (pid: number) => boolean }
export const defaultRunsDir = () => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

export async function readStuckJobs(opts: StuckReadOptions = {}): Promise<StuckJobsReport> {
  const now = (opts.now ?? Date.now)();
  const generated_at = new Date(now).toISOString();
  let jobs: RunningJob[];
  try { jobs = await readRunningJobs(opts.runsDir ?? defaultRunsDir(), opts.lane); }
  catch { return { schema: STUCK_JOBS_SCHEMA, generated_at, known: false, running: 0, stuck: [] }; }
  const stuck = classifyRunning(jobs, now, opts.alive ?? pidAlive);
  return { schema: STUCK_JOBS_SCHEMA, generated_at, known: true, running: jobs.length, stuck };
}

/** Close a ghost's run marker the way dispatchd does: .fin holds the .base mtime seconds. */
export async function closeGhost(runsDir: string, job: string, baseKey: string | null, now: number): Promise<boolean> {
  if (!STRAY_ID_PATTERN.test(job) || baseKey === null) return false;
  await writeFile(join(runsDir, 'queue', 'run', `${job}.fin`), baseKey, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await appendLine(join(runsDir, STUCK_LEDGER), `${scrubSecrets(JSON.stringify({ at: new Date(now).toISOString(), job, action: 'ghost-closed' }))}\n`).catch(() => undefined);
  return true;
}

/** Only commands the fleet starts: launch scripts and the agent CLIs. Never a GUI app bundle. */
const FLEET_COMMAND = /(?:^|[\s/])(?:launch\.sh|orch-pass\.sh)(?:\s|$)|^(?:codex exec|claude -p|devin)(?:\s|$)/;
export const isFleetProcess = (p: StrayProcess): boolean => !/\.app\//.test(p.command) && FLEET_COMMAND.test(p.command);

export interface StuckActionResult { closed: StuckJob[]; stopped: StuckJob[]; skipped: StuckJob[] }
export interface StuckActionDeps extends Pick<StopJobOptions, 'kill' | 'timers' | 'graceMs'> {
  runsDir: string; readers?: Pick<StrayReaders, 'readProcesses'>; now?: () => number; alive?: (pid: number) => boolean; lane?: string;
}

/**
 * Close every ghost's marker, then politely stop stuck jobs (TERM, KILL after 60 s) — at most
 * MAX_STUCK_STOPS_PER_TICK per call, oldest first. Only fleet-shaped processes carrying the job id are signalled.
 */
export async function actOnStuckJobs(deps: StuckActionDeps): Promise<StuckActionResult> {
  const now = (deps.now ?? Date.now)();
  const running = await readRunningJobs(deps.runsDir, deps.lane);
  const byJob = new Map(running.map(j => [j.job, j]));
  const found = classifyRunning(running, now, deps.alive ?? pidAlive);
  const result: StuckActionResult = { closed: [], stopped: [], skipped: [] };
  for (const g of found.filter(s => s.kind === 'ghost')) {
    if (result.closed.length >= MAX_GHOST_CLOSES_PER_TICK) { result.skipped.push(g); continue; }
    if (await closeGhost(deps.runsDir, g.job, byJob.get(g.job)?.baseKey ?? null, now)) result.closed.push(g); else result.skipped.push(g);
  }
  const readers = deps.readers ?? defaultStrayReaders;
  const fleetOnly = { readProcesses: async () => (await readers.readProcesses()).filter(isFleetProcess) };
  const stuck = found.filter(s => s.kind === 'stuck').sort((a, b) => (b.age_min ?? 0) - (a.age_min ?? 0));
  for (const s of stuck) {
    if (result.stopped.length >= MAX_STUCK_STOPS_PER_TICK) { result.skipped.push(s); continue; }
    const r: JobStopResult = await stopJob(s.job, { readers: fleetOnly, kill: deps.kill, timers: deps.timers, graceMs: deps.graceMs ?? STUCK_STOP_GRACE_MS, runsDir: deps.runsDir, now: () => now, by: 'stuck-jobs' });
    if (r.outcome === 'stopped') result.stopped.push(s); else result.skipped.push(s);
  }
  return result;
}

/** Step note, e.g. "codex-local: 6 ghosts closed, 2 stuck stopped". */
export function stuckNote(res: StuckActionResult): string {
  const lanes = new Set([...res.closed, ...res.stopped].map(s => s.lane));
  if (lanes.size === 0) return 'no stuck jobs';
  return [...lanes].sort().map(lane => {
    const g = res.closed.filter(s => s.lane === lane).length, k = res.stopped.filter(s => s.lane === lane).length;
    return `${lane}: ${g} ghost${g === 1 ? '' : 's'} closed, ${k} stuck stopped`;
  }).join('; ');
}
