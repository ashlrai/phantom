import { readLaunchVitals } from '../core/fleet/launch-vitals.js';

export async function cmdFleetVitals(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log('Usage: phm fleet vitals [--json]'); return 0; }
  if (args.some(arg => arg !== '--json') || args.length > 1) { console.error('Usage: phm fleet vitals [--json]'); return 2; }
  const view = await readLaunchVitals();
  if (args.includes('--json')) console.log(JSON.stringify({ schema: 'fleet.vitals.v1', ...view }, null, 2));
  else {
    console.log(`Why isn't it launching: ${view.reason ?? 'unknown'}`);
    console.log(`Next launch window: ${view.nextWindowSeconds === null ? 'unknown' : `${view.nextWindowSeconds} seconds`}; queued: ${view.queued ?? 'unknown'}`);
    for (const lane of view.lanes) console.log(`${lane.lane}: ${lane.running ?? 'unknown'} running of ${lane.target ?? 'unknown'} target; ${lane.queued ?? 'unknown'} queued`);
  }
  return 0;
}
