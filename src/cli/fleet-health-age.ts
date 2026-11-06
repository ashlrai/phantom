import { readFleetHealthAge } from '../core/fleet/health-age.js';
export type { FleetHealthAge } from '../core/fleet/health-age.js';

const USAGE = 'phm fleet health-age [--json]\nRead guardian status age. Exit 0: fresh; 1: stale or unknown; 2: invalid arguments.\nReads ~/.ashlr-runs/supervisor/status-main-guardian.md; fresh means at most 30 minutes old.';

export async function cmdFleetHealthAge(
  args: string[],
  opts: { runsDir?: string; now?: () => number } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const report = await readFleetHealthAge(opts);
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else console.log(`Guardian status: ${report.status}; age: ${report.ageSeconds === null ? 'unknown' : `${Math.floor(report.ageSeconds)} seconds`}; limit: ${report.maxAgeSeconds} seconds.`);
  return report.status === 'fresh' ? 0 : 1;
}
