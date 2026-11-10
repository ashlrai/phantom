import { fleetOrgMap } from '../core/fleet/org-map.js';
import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet map [--json]\nShow the Leader, lanes and running jobs.';

export async function cmdFleetMap(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  const { snapshot } = await buildFleetLiveSnapshot();
  const map = sanitizePublicJson(fleetOrgMap(snapshot));
  console.log(args.includes('--json') ? JSON.stringify(map) : JSON.stringify(map, null, 2));
  return 0;
}
