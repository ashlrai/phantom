/** `phm fleet pulse [--json]`: is the fleet doing well right now. Thin: the numbers are built in core/fleet/pulse.ts. */
import { pulseText, readPulse, type PulseV1 } from '../core/fleet/pulse.js';
import { pulseLanesText, readPulseLanes, type PulseLanesV1 } from '../core/fleet/pulse-lanes.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet pulse [--lanes] [--json]
Is the fleet doing well right now: one sentence, then five numbers, each with its trend against the day before
(↑ up, ↓ down, → flat, ? unknown) and one plain line: PRs merged per hour (with a 24 hour sparkline),
median publish-to-merge time, main branches green, days since the oldest last release (that repo named)
and pools on pace to be spent before reset. The desktop and phone Home Pulse card shows exactly this. Read-only.
--json prints fleet.pulse.v1 {schema,v,asOf,verdict,headline,mergesPerHour,medianMergeSeconds,mainsGreen,daysSinceRelease,poolsOnPace};
each number is {value,trend,better,line}. Unknown is null with the reason in line, never 0.
--lanes shows what we optimize for per lane over the last 24 hours: PRs merged per hour, median minutes from publish to merge,
EMPTY rate and jobs running vs capacity, plus fleet totals with 24 hourly values each. The desktop and phone Pulse strip shows the totals.
--lanes --json prints fleet.pulse.lanes.v1 {schema,v,as_of,window_h,headline,lanes:[{lane,state,running,capacity,merged_per_h,median_open_to_merge_s,empty_rate,merged,finished,line}],totals}.
A lane's state is measured, idle (nothing happened anywhere, zeros are real) or no_data ("no data yet"); unknown is null, never 0.`;

export async function cmdFleetPulse(args: string[], read: () => Promise<PulseV1> = () => readPulse(), readLanes: () => Promise<PulseLanesV1> = () => readPulseLanes()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const flags = new Set(args);
  if (flags.size !== args.length || args.some(arg => arg !== '--json' && arg !== '--lanes')) { console.error(usage); return 2; }
  const json = flags.has('--json');
  if (flags.has('--lanes')) {
    const lanes = sanitizePublicJson(await readLanes()) as PulseLanesV1;
    console.log(json ? JSON.stringify(lanes, null, 2) : pulseLanesText(lanes).join('\n'));
    return 0;
  }
  const pulse = sanitizePublicJson(await read()) as PulseV1;
  console.log(json ? JSON.stringify(pulse, null, 2) : pulseText(pulse).join('\n'));
  return 0;
}
