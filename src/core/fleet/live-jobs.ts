/** The dispatcher marker reader shared with jobs stuck; observation only. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { defaultRunsDir, readRunningJobs, type StuckReadOptions } from './running-stuck.js';
import { readWindow } from './runs-job-tail.js';
import { scrubJobLogLine } from './runs-job-detail.js';
import { defaultWtRoot } from './worktrees.js';
export interface LiveJob {
  id: string; lane: string; repo: string; started: string; elapsed: number | 'unknown';
  process?: 'live' | 'gone' | 'unknown';
  processLive?: boolean;
  lastLogWrite: string; lastLine: string; status: 'moving' | 'quiet' | 'stuck' | 'stale' | 'unknown';
}
export interface LiveJobsReport { schema: 'jobs.live.v1'; generatedAt: string; known: boolean; jobs: LiveJob[]; other_worktrees?: number | null; finished_recent?: { id: string; finished: string }[] }
export interface LiveJobsSnapshot extends Omit<LiveJobsReport, 'jobs'> {
  running: (Pick<LiveJob, 'id' | 'lane' | 'repo' | 'elapsed'> & { process: NonNullable<LiveJob['process']>; lastLogWriteAge: number | 'unknown'; state: LiveJob['status'] })[];
}
export const LIVE_JOBS_FILE = 'queue/live-jobs.json';
const STALE_AFTER_MS = 48 * 60 * 60_000;
const iso = (ms: number | null) => ms !== null && Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : 'unknown';
const processAlive = (pid: number): boolean | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? false : code === 'EPERM' ? true : null;
  }
};

export async function readLiveJobs(opts: Omit<StuckReadOptions, 'alive'> & { wtRoot?: string; alive?: (pid: number) => boolean | null } = {}): Promise<LiveJobsReport> {
  const now = (opts.now ?? Date.now)(), runsDir = opts.runsDir ?? defaultRunsDir();
  const report: LiveJobsReport = { schema: 'jobs.live.v1', generatedAt: iso(now), known: false, jobs: [] };
  let running;
  try { running = await readRunningJobs(runsDir, opts.lane); } catch { return report; }
  report.known = true;
  for (const job of running.sort((a, b) => a.job.localeCompare(b.job))) {
    let lastLine = 'unknown';
    try {
      const tail = await readWindow(join(runsDir, `${job.job}.log`), null, 16_384);
      // Discard a partial first line so a cut credential cannot escape redaction.
      const start = tail.from > 0 ? tail.data.indexOf(10) + 1 : 0;
      const text = tail.from > 0 && start === 0 ? '' : tail.data.toString('utf8', start);
      const line = stripVTControlCharacters(text).split(/\r?\n/).map(s => s.trim()).filter(s => /[\p{L}\p{N}]/u.test(s)).at(-1);
      if (line) lastLine = scrubJobLogLine(line).slice(0, 120);
    } catch { /* Missing, linked or unreadable logs stay unknown. */ }
    const idle = now - (job.logMtimeMs ?? job.startedMs ?? now);
    let alive: boolean | null = null;
    try { if (job.pid !== null && Number.isSafeInteger(job.pid) && job.pid > 0) alive = (opts.alive ?? processAlive)(job.pid); } catch { /* Failed probes stay unknown. */ }
    const processState = alive === true ? 'live' : alive === false ? 'gone' : 'unknown';
    // Age alone never proves that a process ended; unknown evidence needs a fresh observation.
    const status = processState === 'gone' && job.startedMs !== null && now - job.startedMs > STALE_AFTER_MS ? 'stale'
      : processState === 'unknown' ? 'unknown' : processState === 'gone' || idle > 60 * 60_000 ? 'stuck'
      : job.logMtimeMs === null ? 'unknown' : idle < 10 * 60_000 ? 'moving' : 'quiet';
    report.jobs.push({ id: scrubJobLogLine(job.job), lane: scrubJobLogLine(job.lane), repo: scrubJobLogLine(job.repo ?? 'unknown'),
      started: iso(job.startedMs), elapsed: iso(job.startedMs) === 'unknown' ? 'unknown' : Math.max(0, Math.floor((now - job.startedMs!) / 1000)),
      lastLogWrite: iso(job.logMtimeMs), lastLine, process: processState, processLive: alive ?? undefined, status });
  }
  try {
    const entries = await readdir(opts.wtRoot ?? defaultWtRoot(), { withFileTypes: true });
    const ids = new Set(running.map(j => j.job));
    report.other_worktrees = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !ids.has(e.name)).length;
  } catch { report.other_worktrees = null; }
  const names = await readdir(join(runsDir, 'queue/run'));
  const finished = await Promise.all(names.filter(n => n.endsWith('.fin')).map(async n => {
    try { return { id: scrubJobLogLine(n.slice(0, -4)), time: (await stat(join(runsDir, 'queue/run', n))).mtimeMs }; } catch { return null; }
  }));
  report.finished_recent = finished.filter((f): f is { id: string; time: number } => f !== null && !running.some(j => j.job === f.id))
    .sort((a, b) => b.time - a.time).slice(0, 10).map(f => ({ id: f.id, finished: iso(f.time) }));
  return report;
}

/** A private sibling temporary file and rename keep readers on complete snapshots. */
export async function writeLiveJobs(file: string, report: LiveJobsReport, replace = rename): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const now = Date.parse(report.generatedAt);
    const snapshot: LiveJobsSnapshot = { schema: report.schema, generatedAt: report.generatedAt, known: report.known,
      running: report.jobs.map(j => ({ id: j.id, lane: j.lane, repo: j.repo, elapsed: j.elapsed,
        process: j.process ?? (j.processLive === true ? 'live' : j.processLive === false ? 'gone' : 'unknown'),
        lastLogWriteAge: j.lastLogWrite === 'unknown' || !Number.isFinite(now) ? 'unknown' : Math.max(0, Math.floor((now - Date.parse(j.lastLogWrite)) / 1000)),
        state: j.status })),
      finished_recent: report.finished_recent ?? [], other_worktrees: report.other_worktrees ?? null };
    let data = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(data) > 32 * 1024) { snapshot.finished_recent = []; data = `${JSON.stringify(snapshot)}\n`; }
    if (Buffer.byteLength(data) > 32 * 1024) throw new Error('Live jobs exceed 32 KB');
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await replace(temp, file);
  } finally { await rm(temp, { force: true }); }
}
