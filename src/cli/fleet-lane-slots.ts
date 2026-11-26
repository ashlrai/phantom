import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { brandBadge, terminalColor } from '../core/brand/registry.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readFleetLiveReplica, stampLocalFleetSnapshot } from '../core/fleet/fleet-replica.js';

const usage = `Usage: phm fleet lane-slots [--json]
Read current standing lane slots, even during mirror prep. Unobserved capacity is unknown.`;

/** The Fleet screen's slot observation, through the same API projection. */
export async function cmdFleetLaneSlots(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const snapshot = readFleetLiveReplica() ?? stampLocalFleetSnapshot((await buildFleetLiveSnapshot()).snapshot);
  const lanes = snapshot.lanes.map(lane => ({ ...lane,
    slots: lane.capReason === 'No standing tick has reported lanes in the last 10 minutes.' ? null : lane.slots,
  }));
  const result = sanitizePublicJson({ schema: 'fleet.lane-slots.v1', source: snapshot.source, lanes });
  const color = terminalColor();
  console.log(args.includes('--json') ? JSON.stringify(result)
    : [
      ...(snapshot.source ? [`Source: ${snapshot.source.machine ?? 'unknown'}, as of ${snapshot.source.asOf ?? 'unknown'}.`] : []),
      ...lanes.map(lane => `${brandBadge(lane.lane, color)}${lane.lane}: ${lane.slots ?? 'unknown'} slots, ${lane.busy ?? 'unknown'} working${snapshot.source && lane.capReason ? ` — ${lane.capReason}` : ''}`),
    ].join('\n'));
  return 0;
}
