/** `phm fleet stuck`: read-only list of queued jobs that can never launch. Logic: core/fleet/stuck-jobs.ts; read: core/fleet/dispatch-stuck.ts. */
import { readDispatchStuckJobs, type DispatchStuckPaths, type DispatchStuckRead } from '../core/fleet/dispatch-stuck.js';
import { stuckJobLine } from '../core/fleet/stuck-jobs.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export { readDispatchStuckJobs as readStuckJobs } from '../core/fleet/dispatch-stuck.js';
export type { DispatchStuckPaths as StuckJobsPaths, DispatchStuckRead as StuckJobsRead } from '../core/fleet/dispatch-stuck.js';

const USAGE = 'Usage: phm fleet stuck [--runs-dir <directory>] [--events <file>] [--ready <file>] [--json]\nList queued jobs that keep being refused or keep failing and have not launched since: lane, cause, how long, and what to do next. Reads the end of the dispatch event log and the ready list; changes nothing. Exit 1 when the event log cannot be read.';

export async function cmdFleetStuck(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const paths: DispatchStuckPaths = {};
  const flags = { '--runs-dir': 'runsDir', '--events': 'events', '--ready': 'ready' } as const;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !(arg === '--json' || arg in flags)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) { console.error(USAGE); return 2; }
    paths[flags[arg as keyof typeof flags]] = value;
  }
  const report = sanitizePublicJson(await readDispatchStuckJobs(paths)) as DispatchStuckRead;
  if (seen.has('--json')) console.log(JSON.stringify(report));
  else if (report.count === null) console.log(`Stuck jobs: unknown; the dispatch event log is ${report.sources.events === 'missing' ? 'missing' : 'unreadable'}.`);
  else if (report.count === 0) console.log('No stuck jobs.');
  else for (const row of report.jobs) console.log(stuckJobLine(row));
  return report.count === null ? 1 : 0;
}
