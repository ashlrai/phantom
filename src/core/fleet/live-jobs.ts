/** The dispatcher marker reader shared with jobs stuck; observation only. */
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { defaultRunsDir, pidAlive, readRunningJobs, type StuckReadOptions } from './running-stuck.js';
import { readWindow } from './runs-job-tail.js';
import { scrubJobLogLine } from './runs-job-detail.js';
export interface LiveJob {
  id: string; lane: string; repo: string; started: string; elapsed: number | 'unknown';
  lastLogWrite: string; lastLine: string; status: 'moving' | 'quiet' | 'stuck' | 'unknown';
}
export interface LiveJobsReport { schema: 'jobs.live.v1'; generatedAt: string; known: boolean; jobs: LiveJob[] }
export const LIVE_JOBS_FILE = 'queue/live-jobs.json';
const iso = (ms: number | null) => ms !== null && Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : 'unknown';

export async function readLiveJobs(opts: StuckReadOptions = {}): Promise<LiveJobsReport> {
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
    const status = job.pid === null || !(opts.alive ?? pidAlive)(job.pid) || idle > 60 * 60_000 ? 'stuck'
      : job.logMtimeMs === null ? 'unknown' : idle < 10 * 60_000 ? 'moving' : 'quiet';
    report.jobs.push({ id: scrubJobLogLine(job.job), lane: scrubJobLogLine(job.lane), repo: scrubJobLogLine(job.repo ?? 'unknown'),
      started: iso(job.startedMs), elapsed: iso(job.startedMs) === 'unknown' ? 'unknown' : Math.max(0, Math.floor((now - job.startedMs!) / 1000)),
      lastLogWrite: iso(job.logMtimeMs), lastLine, status });
  }
  return report;
}

/** A private sibling temporary file and rename keep readers on complete snapshots. */
export async function writeLiveJobs(file: string, report: LiveJobsReport, replace = rename): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 });
    await replace(temp, file);
  } finally { await rm(temp, { force: true }); }
}
