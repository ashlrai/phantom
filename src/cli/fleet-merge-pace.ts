/** Read-only merge counts and time to merge over the last six hours. */
import { fleetMergePace, type MergePaceReport, type MergePaceRow } from '../core/fleet/merge-pace.js';
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';

export { fleetMergePace };
export type { MergePaceReport, MergePaceRow };

const usage = 'Usage: ashlr fleet merge-pace [--json]';

export async function cmdFleetMergePace(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShow merges, merges per hour and median time to merge in seconds by repo, plus a total, over the last 6 hours. Reads ~/.ashlr-runs/metrics/jobs.jsonl. Counts the latest MERGED outcome per job; missing or invalid times are excluded from medians. Unreadable metrics are unknown.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) {
    console.error(`error: invalid fleet merge-pace arguments\n${usage}`);
    return 2;
  }
  const report = await fleetMergePace(read, now);
  console.log(args.includes('--json') ? JSON.stringify(report) : report.rows === null ? 'Merge pace: unknown (metrics unreadable)'
    : report.rows.map(row => `${row.repo}: ${row.merges} merges, ${row.merges_per_hour.toFixed(2)} per hour, median time to merge: ${row.median_ttm_s ?? 'unknown'} seconds`).join('\n'));
  return 0;
}
