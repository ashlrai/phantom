import { readFileSync } from 'node:fs';
import { computeIdleAllowance, type IdleJob, type IdleSnapshot } from '../core/metrics/idle-allowance.js';

const usage = 'Usage: phm metrics idle --status <snapshot.json> [--status <snapshot.json> ...] --jobs <jobs.jsonl> [--json]\n';

export function cmdMetrics(args: string[]): number {
  if (args[0] === '--help' || args[0] === 'help' || (args[0] === 'idle' && args[1] === '--help')) { process.stdout.write(usage); return 0; }
  const statuses: string[] = [];
  let jobsPath: string | undefined;
  let json = false;
  if (args[0] !== 'idle') { process.stderr.write(usage); return 2; }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if ((arg === '--status' || arg === '--jobs') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--status') statuses.push(value);
      else if (jobsPath === undefined) jobsPath = value;
      else { process.stderr.write(usage); return 2; }
    } else { process.stderr.write(usage); return 2; }
  }
  if (!statuses.length || !jobsPath) { process.stderr.write(usage); return 2; }
  try {
    const snapshots: IdleSnapshot[] = statuses.flatMap(path => {
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return (Array.isArray(data) ? data : [data]) as IdleSnapshot[];
    });
    const jobs = readFileSync(jobsPath, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as IdleJob);
    const report = computeIdleAllowance(snapshots, jobs);
    if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      process.stdout.write(`Idle slot-minutes (${report.from} to ${report.to})\n`);
      for (const lane of report.lanes) process.stdout.write(`${lane.lane}: ${lane.idleSlotMinutes} idle, ${lane.pausedSlotMinutes} paused; reasons: ${JSON.stringify(lane.pausedReasons)}\n`);
      for (const job of report.stuckJobs) process.stdout.write(`Stuck ${job.id} (${job.lane}): ${job.elapsedMinutes} minutes; median ${job.medianWallMinutes}\n`);
    }
    return 0;
  } catch { process.stderr.write('Unable to read or parse idle metrics input.\n'); return 1; }
}
