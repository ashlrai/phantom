/** Read-only per-lane one-ask reward rollup over a host jobs ledger. */
import { readLaneReward, type LaneRewardDeps, type LaneRewardV1 } from '../core/fleet/lane-reward.js';

const usage = `Usage: phm fleet lane-reward [--jobs <jobs.jsonl>] [--json]
  --jobs <path>  Metrics jobs ledger to read (default ~/.ashlr-runs/metrics/jobs.jsonl).
Prints one line per lane: attempts scored, unscored and mean rewardPerToken.
Observation only: never writes, never routes, never touches merge authority.`;

const reward = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(6));

function formatLanes(report: LaneRewardV1): string {
  const header = `fleet lane-reward: ${report.attempts} attempts, ${report.scored} scored, ` +
    `${report.unscored} unscored, mean reward ${reward(report.meanReward)}` +
    (report.source === 'healthy' ? '' : ` (source ${report.source})`);
  return [header, ...report.lanes.map(lane =>
    `${lane.lane}: ${lane.attempts} attempts, ${lane.scored} scored, ${lane.unscored} unscored, ` +
    `mean reward ${reward(lane.meanReward)}`)].join('\n');
}

export async function cmdFleetLaneReward(args: string[], deps?: Partial<LaneRewardDeps>): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  let json = false;
  let jobs: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--jobs' && jobs === undefined && i + 1 < args.length && !args[i + 1]!.startsWith('--')) jobs = args[++i];
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  const report = await readLaneReward({ jobsPath: jobs, deps });
  if (report.source === 'missing') {
    if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stderr.write('error: jobs ledger unavailable\n');
    return 1;
  }
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${formatLanes(report)}\n`);
  return 0;
}
