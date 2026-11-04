/** `phm resources usage [--json]`: thin wrapper over the fleet-usage.v1 reader. */
import { readFleetUsage, type FleetUsageLane } from '../core/resources/fleet-usage.js';

const cell = (v: number | string | null): string => v === null ? '-' : String(v);

function printTable(lanes: FleetUsageLane[]): void {
  const rows = lanes.map(l => [l.lane, l.window, l.known ? `${cell(l.used)}/${cell(l.limit)} ${l.quota_unit}` : 'unknown',
    cell(l.seconds_to_reset), l.waste_risk, l.stale ? 'stale' : '']);
  const header = ['lane', 'window', 'used/limit', 'reset-s', 'waste', ''];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  for (const r of [header, ...rows]) console.log(`  ${r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()}`);
}

export async function cmdResourceUsage(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: phm resources usage [--json]');
    console.log('Read-only per-lane fleet quota feed (fleet-usage.v1) from ~/.ashlr-runs/queue; numbers only.');
    return 0;
  }
  if (args.some(a => a !== '--json') || args.length > 1) {
    process.stderr.write('Invalid usage arguments; use phm resources usage --help.\n');
    return 2;
  }
  const usage = await readFleetUsage();
  if (args.includes('--json')) console.log(JSON.stringify(usage, null, 2));
  else printTable(usage.lanes);
  return 0;
}
