import { mapWindowMinutes } from '../core/fleet/org-map.js';
import { readFleetOrgMap } from '../core/verse/fleet-org-map-api.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet map [--minutes N] [--json]\nShow the org and retained agent messages (default 60 minutes; 1..1440).';

export async function cmdFleetMap(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  let minutes = 60;
  const seen = new Set<string>();
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (seen.has(flag)) return 2;
      seen.add(flag);
      if (flag === '--minutes' && args[i + 1] !== undefined) minutes = mapWindowMinutes(args[++i]);
      else if (flag !== '--json') return 2;
    }
  } catch { return 2; }
  const map = sanitizePublicJson(await readFleetOrgMap(minutes));
  console.log(args.includes('--json') ? JSON.stringify(map) : JSON.stringify(map, null, 2));
  return 0;
}
