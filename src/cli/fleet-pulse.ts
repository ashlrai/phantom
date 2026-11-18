/** `phm fleet pulse [--json]`: is the fleet doing well right now. Thin: the numbers are built in core/fleet/pulse.ts. */
import { pulseText, readPulse, type PulseV1 } from '../core/fleet/pulse.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet pulse [--json]
Is the fleet doing well right now: one sentence, then five numbers, each with its trend against the day before
(↑ up, ↓ down, → flat, ? unknown) and one plain line: PRs merged per hour (with a 24 hour sparkline),
median publish-to-merge time, main branches green, days since the oldest last release (that repo named)
and pools on pace to be spent before reset. The desktop and phone Home Pulse card shows exactly this. Read-only.
--json prints fleet.pulse.v1 {schema,v,asOf,verdict,headline,mergesPerHour,medianMergeSeconds,mainsGreen,daysSinceRelease,poolsOnPace};
each number is {value,trend,better,line}. Unknown is null with the reason in line, never 0.`;

export async function cmdFleetPulse(args: string[], read: () => Promise<PulseV1> = () => readPulse()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--json')) { console.error(usage); return 2; }
  const pulse = sanitizePublicJson(await read()) as PulseV1;
  console.log(args[0] === '--json' ? JSON.stringify(pulse, null, 2) : pulseText(pulse).join('\n'));
  return 0;
}
