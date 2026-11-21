/** Stat/PID evidence only; hand ghosts to the dispatcher without signalling or closing attempts. */
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyRunning, defaultRunsDir, pidAlive, readRunningJobs, type StuckReadOptions } from './running-stuck.js';

const HOUR = 3_600_000;
export interface GhostJob { id: string; lane: string; ageHours: number | null; state: 'live' | 'stuck' | 'ghost'; reason: string }
export interface GhostReport { schema: 'fleet.ghosts.v1'; known: boolean; jobs: GhostJob[]; marked: string[] }
export async function fleetGhosts(opts: StuckReadOptions & { apply?: boolean; minAgeHours?: number; limit?: number } = {}): Promise<GhostReport> {
  const root = opts.runsDir ?? defaultRunsDir(), now = (opts.now ?? Date.now)(), alive = opts.alive ?? pidAlive;
  const report: GhostReport = { schema: 'fleet.ghosts.v1', known: false, jobs: [], marked: [] };
  let jobs;
  try { jobs = await readRunningJobs(root, opts.lane, true); } catch { return report; }
  report.known = true;
  const classified = new Map(classifyRunning(jobs, now, alive).map(j => [j.job, j]));
  for (const job of jobs) {
    const start = job.startedMs ?? job.markerMtimeMs ?? null;
    const age = start === null ? null : (now - start) / HOUR;
    const lastWrite = Math.max(job.logMtimeMs ?? 0, job.outputMtimeMs ?? 0, start ?? 0);
    const quiet = lastWrite > 0 ? (now - lastWrite) / HOUR : null;
    const old = classified.get(job.job);
    const reason = job.pid !== null && !alive(job.pid) ? 'recorded pid is gone'
      : job.pid === null && quiet !== null && quiet > 2 ? 'no pid and no output for over 2h'
      : age !== null && age > 24 && quiet !== null && quiet > 24 ? 'over 24h with no output growth' : null;
    const state = reason ? 'ghost' : quiet !== null && quiet <= 0.5 ? 'live' : old?.kind ?? 'live';
    report.jobs.push({ id: job.job, lane: job.lane, ageHours: age, state, reason: reason ?? (state === 'stuck' ? old?.why : null) ?? 'recent output or process present' });
  }
  if (opts.apply) for (const job of report.jobs.filter(j => j.state === 'ghost').sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0) || a.id.localeCompare(b.id))) {
    if (report.marked.length >= (opts.limit ?? Infinity)) break;
    if (opts.minAgeHours !== undefined && (job.ageHours === null || job.ageHours <= opts.minAgeHours)) continue;
    try { await mkdir(join(root, 'queue', 'run', `${job.id}.reaping`), { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    report.marked.push(job.id);
    await appendFile(join(root, 'queue', 'dispatch-events.log'), `GHOST_REAP ${job.id} ${job.lane}: ${job.reason}\n`, { mode: 0o600 });
  }
  return report;
}
