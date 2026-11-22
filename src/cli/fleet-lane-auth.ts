import { formatLaneAuthText, readLaneAuth, raiseLaneAuthAsks } from '../core/fleet/lane-auth.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: phm fleet lane-auth [--json]';

export async function cmdFleetLaneAuth(args: string[], deps: {
  read?: typeof readLaneAuth; raise?: typeof raiseLaneAuthAsks;
} = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(USAGE); return 2; }
  const report = await (deps.read ?? readLaneAuth)();
  await (deps.raise ?? raiseLaneAuthAsks)(report);
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(report)) : formatLaneAuthText(report));
  return 0;
}
