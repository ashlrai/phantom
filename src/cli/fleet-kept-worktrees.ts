/** Read-only kept worktree report. Never removes directories or changes queue state. */
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KeptWorktreeReaders {
  home?: string;
  now?: () => number;
  readText?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ birthtimeMs: number; mtimeMs: number; isDirectory(): boolean }>;
}
export interface KeptWorktreeReport {
  schema: 'fleet.kept-worktrees.v1';
  jobs: { job: string; ageHours: number | null; state: string; done: boolean }[];
  doneCount: number;
  red: boolean;
}

export async function readKeptWorktrees(deps: KeptWorktreeReaders = {}): Promise<KeptWorktreeReport> {
  const home = deps.home ?? homedir(), read = deps.readText ?? (path => readFile(path, 'utf8'));
  const stat = deps.stat ?? lstat, now = (deps.now ?? Date.now)();
  const status = JSON.parse(await read(join(home, '.ashlr-runs/queue/status.json')));
  if (!Array.isArray(status?.kept_worktrees) || !status.kept_worktrees.every((job: unknown) =>
    typeof job === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job))) throw new Error('Invalid kept worktrees');
  const kept = [...new Set<string>(status.kept_worktrees)];
  const outcomes = new Map<string, { state: string; time: number }>();
  let log = '';
  try { log = await read(join(home, '.ashlr-runs/metrics/jobs.jsonl')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const line of log.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row?.event !== 'outcome' || typeof row.job !== 'string' || typeof row.state !== 'string'
        || !/^[A-Z][A-Z0-9_ -]{0,63}$/.test(row.state)) continue;
      const time = Date.parse(row.ts);
      const previous = outcomes.get(row.job);
      // Logs without timestamps retain their append order; ties use the last row.
      if (!previous || !Number.isFinite(time) || !Number.isFinite(previous.time) || time >= previous.time)
        outcomes.set(row.job, { state: row.state, time });
    } catch { /* Ignore incomplete or malformed JSONL rows. */ }
  }
  const jobs = await Promise.all(kept.map(async job => {
    let ageHours: number | null = null;
    try {
      const info = await stat(join(home, 'Projects/ashlrai/wt', job));
      const created = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      if (info.isDirectory() && Number.isFinite(created)) ageHours = Math.max(0, (now - created) / 3_600_000);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const state = outcomes.get(job)?.state ?? 'none';
    return { job, ageHours, state, done: state === 'MERGED' || state === 'CLOSED' };
  }));
  const doneCount = jobs.filter(job => job.done).length;
  return { schema: 'fleet.kept-worktrees.v1', jobs, doneCount, red: doneCount >= 10 };
}

const usage = 'Usage: ashlr fleet kept-worktrees [--json]\nRead-only report of kept worktrees: age in hours, latest outcome, and done for MERGED or CLOSED. Red and exit 1 at 10 done worktrees. Unknown ages are null in JSON.';
export async function cmdFleetKeptWorktrees(args: string[], deps: KeptWorktreeReaders = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  try {
    const report = await readKeptWorktrees(deps);
    console.log(args.includes('--json') ? JSON.stringify(report) : [
      ...report.jobs.map(row => `${row.job}: ${row.ageHours === null ? 'unknown age' : `${row.ageHours.toFixed(1)} hours`}; ${row.state}${row.done ? '; done' : ''}`),
      `${report.red ? 'RED' : 'OK'}: ${report.doneCount} done kept worktrees`,
    ].join('\n'));
    return report.red ? 1 : 0;
  } catch { console.error('fleet kept-worktrees: unable to read kept worktree evidence'); return 1; }
}
