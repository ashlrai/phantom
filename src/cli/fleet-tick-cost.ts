import { readTickCost } from '../core/fleet/tick-cost.js';

export async function cmdFleetTickCost(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm fleet tick-cost [--json]\nLast two hours; wall times in seconds. Bounded log sample; unknown rates stay null.'); return 0;
  }
  if (args.some(arg => arg !== '--json')) { console.error('Usage: phm fleet tick-cost [--json]'); return 2; }
  const report = await readTickCost();
  console.log(args.includes('--json') ? JSON.stringify(report) :
    `Tick wall: p50 ${report.tickWallP50 ?? 'unknown'}s, p95 ${report.tickWallP95 ?? 'unknown'}s; SLOW: ${report.slowCount}, per hour ${report.slowPerHour ?? 'unknown'}${report.truncated ? ' (log sample)' : ''}`);
  return report.known ? 0 : 1;
}
