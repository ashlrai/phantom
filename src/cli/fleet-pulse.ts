/** `phm fleet pulse [--json]`: is the fleet doing well right now. Thin: the numbers are built in core/fleet/pulse.ts. */
import { pulseText, readPulse, type PulseV1 } from '../core/fleet/pulse.js';
import { pulseLanesText, readPulseLanes, type PulseLanesV1 } from '../core/fleet/pulse-lanes.js';
import { pulseAlertsText, readPulseAlerts, type PulseAlertsV1 } from '../core/fleet/pulse-alerts.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet pulse [--lanes | --alerts [--no-notify]] [--json]
Is the fleet doing well right now: one sentence, then five numbers, each with its trend against the day before
(↑ up, ↓ down, → flat, ? unknown) and one plain line: PRs merged per hour (with a 24 hour sparkline),
median publish-to-merge time, main branches green, days since the oldest last release (that repo named)
and pools on pace to be spent before reset. The desktop and phone Home Pulse card shows exactly this. Read-only.
--json prints fleet.pulse.v1 {schema,v,asOf,verdict,headline,mergesPerHour,medianMergeSeconds,mainsGreen,daysSinceRelease,poolsOnPace};
each number is {value,trend,better,line}. Unknown is null with the reason in line, never 0.
--lanes shows what we optimize for per lane over the last 24 hours: PRs merged per hour, median minutes from publish to merge,
EMPTY rate and jobs running vs capacity, plus fleet totals with 24 hourly values each. The desktop and phone Pulse strip shows the totals.
--lanes --json prints fleet.pulse.lanes.v1 {schema,v,as_of,window_h,headline,lanes:[{lane,state,running,capacity,merged_per_h,median_open_to_merge_s,empty_rate,merged,finished,line}],totals}.
A lane's state is measured, idle (nothing happened anywhere, zeros are real) or no_data ("no data yet"); unknown is null, never 0.
--alerts shows what needs you now, or "All lanes busy.": stalled (no job started and no PR merged for 30 minutes: an incident), starved
(a lane below its slots with nothing queued for 30 minutes), wasting (a lane's EMPTY rate above 40% over its last 20 jobs) and pool_waste
(a plan on track to leave more than 10% unused) and release_stale (a repo over 24 hours since its last release with PRs merged since, or a release with 0 assets; see phm release cadence). The desktop and phone Pulse strip shows them as a red row. Each new alert also sends one
plain notice (email outbox and Telegram, as for main-red-notify), at most once an hour per alert; --no-notify only looks.
--alerts --json prints fleet.pulse.alerts.v1 {schema,v,as_of,alerts:[{kind,lane,since,detail,fix_hint}],unknown:[...]}. since is null for a
projection (pool_waste). unknown lists checks that could not be made; a check that could not be made never counts as fine.`;

export async function cmdFleetPulse(args: string[], read: () => Promise<PulseV1> = () => readPulse(), readLanes: () => Promise<PulseLanesV1> = () => readPulseLanes(),
  readAlerts: (notify: boolean) => Promise<PulseAlertsV1> = notify => readPulseAlerts({ notify })): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const flags = new Set(args);
  if (flags.size !== args.length || args.some(arg => !['--json', '--lanes', '--alerts', '--no-notify'].includes(arg))
    || (flags.has('--lanes') && flags.has('--alerts')) || (flags.has('--no-notify') && !flags.has('--alerts'))) { console.error(usage); return 2; }
  const json = flags.has('--json');
  if (flags.has('--alerts')) {
    const alerts = sanitizePublicJson(await readAlerts(!flags.has('--no-notify'))) as PulseAlertsV1;
    console.log(json ? JSON.stringify(alerts, null, 2) : pulseAlertsText(alerts).join('\n'));
    return 0;
  }
  if (flags.has('--lanes')) {
    const lanes = sanitizePublicJson(await readLanes()) as PulseLanesV1;
    console.log(json ? JSON.stringify(lanes, null, 2) : pulseLanesText(lanes).join('\n'));
    return 0;
  }
  const pulse = sanitizePublicJson(await read()) as PulseV1;
  console.log(json ? JSON.stringify(pulse, null, 2) : pulseText(pulse).join('\n'));
  return 0;
}
