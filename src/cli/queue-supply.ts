/** `phm queue supply [--json]`: thin argv layer over core/fleet/queue-supply.ts. Read-only. */
const QUEUE_SUPPLY_USAGE = `Usage: phm queue supply [--json]
One line per pool: usage left, hours to reset, jobs queued for it, its recent starts per hour and the hours of
work queued (ready / starts per hour), with a plain verdict ("Claude: 0 jobs queued, 16% left, about 3 hours of
usage idle"). Pools that need work come first. JSON (queue.supply.v1) with --json. Unknown stays unknown.`;

export async function cmdQueueSupply(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h')) { console.log(QUEUE_SUPPLY_USAGE); return 0; }
  if (args.some(a => a !== '--json')) { console.error(QUEUE_SUPPLY_USAGE); return 2; }
  try {
    const { readQueueSupply, formatQueueSupplyText } = await import('../core/fleet/queue-supply.js');
    const data = await readQueueSupply();
    console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : formatQueueSupplyText(data));
    return 0;
  } catch {
    console.error('Queue supply unavailable.');
    return 1;
  }
}
