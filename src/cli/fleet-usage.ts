import { addFleetUsage, fleetUsageReport, readFleetUsage } from '../core/fleet/usage-pacing.js';

export async function cmdFleetUsage(args: string[]): Promise<number> {
  try {
    if (args.length === 0 || (args.length === 1 && args[0] === '--json')) {
      const report = fleetUsageReport(readFleetUsage());
      if (args[0] === '--json') console.log(JSON.stringify(report));
      else for (const [id, pool] of Object.entries(report.pools)) {
        console.log(`${id}: ${pool.pointsPerHour?.toFixed(2) ?? 'unknown'} points/h; 12h ${pool.pointsPerHour12h?.toFixed(2) ?? 'unknown'}; needed ${pool.paceNeeded?.toFixed(2) ?? 'unknown'}; run-out ${pool.projectedRunOutAt ?? 'unknown'}; throttle ${pool.throttle}`);
      }
      return 0;
    }
    if (args.length !== 5 || args[0] !== 'add' || args[3] !== '--at' || !args[2].trim()) throw new Error('usage: phm fleet usage add <pool> <pct> --at <timestamp>');
    addFleetUsage(args[1], Number(args[2]), args[4]);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Fleet usage failed');
    return 2;
  }
}
