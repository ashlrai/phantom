import { readFile } from 'node:fs/promises';
import { planFleetShed } from '../core/fleet/shed-plan.js';
import { readQueueStatusView } from '../core/fleet/queue-status-read.js';

const usage = 'Usage: phm fleet shed-plan [--json]';
export async function cmdFleetShedPlan(args: string[], reader: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const result = await readQueueStatusView(
    value => planFleetShed(value),
    { read: reader, subject: 'phm fleet shed-plan' },
  );
  if (!result.ok) {
    console.log(args.includes('--json')
      ? JSON.stringify({ schema: 'fleet.shed-plan.v1', readOnly: true, error: result.message })
      : result.message);
    return 2;
  }
  const plan = result.view;
  if (args.includes('--json')) console.log(JSON.stringify(plan));
  else console.log(`Memory pressure: ${plan.pressure} (free: ${plan.memFreePct === null ? 'unknown' : `${plan.memFreePct}%`}; swap: ${plan.swapGb === null ? 'unknown' : `${plan.swapGb} GiB`}).\n${plan.nextAction}\n${plan.gaps.join('\n')}`);
  return 0;
}
