import { readGoals } from '../core/fleet/goals.js';

export async function cmdGoals(args: string[]): Promise<number> {
  const usage = 'Usage: phm goals [--json]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const goals = await readGoals();
  if (args.includes('--json')) console.log(JSON.stringify(goals));
  else {
    console.log('Goals — jobs launched in the last 24 hours');
    if (!goals.available) console.log('Dispatcher status is unknown.');
    for (const row of goals.lanes) console.log(`${row.lane}: ${row.mergesPerHour ?? 'unknown'} merges/hour · median ${row.medianOpenToMergeSeconds ?? 'unknown'} seconds · empty rate ${row.emptyRate === null ? 'unknown' : `${row.emptyRate * 100}%`}`);
    for (const row of goals.pools) console.log(`${row.pool}: ${row.usedPercent === null ? 'unknown' : `${row.usedPercent}% used`} · reset ${row.resetAt ?? 'unknown'}`);
  }
  return goals.available ? 0 : 1;
}
