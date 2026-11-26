import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { brandBadge, terminalColor } from '../core/brand/registry.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet lane-slots [--json]
Read current standing lane slots, even during mirror prep. Unobserved capacity is unknown.`;

/** The Fleet screen's slot observation, through the same API projection. */
export async function cmdFleetLaneSlots(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const { snapshot, laneSlotsObserved } = await buildFleetLiveSnapshot();
  const lanes = snapshot.lanes.map(lane => ({ ...lane,
    slots: laneSlotsObserved ? lane.slots : null,
  }));
  const result = sanitizePublicJson({ schema: 'fleet.lane-slots.v1', lanes });
  const color = terminalColor();
  console.log(args.includes('--json') ? JSON.stringify(result)
    : lanes.map(lane => `${brandBadge(lane.lane, color)}${lane.lane}: ${lane.slots ?? 'unknown'} slots, ${lane.busy} working`).join('\n'));
  return 0;
}
