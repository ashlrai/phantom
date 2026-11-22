import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatLaneAuthText, readLaneAuth, raiseLaneAuthAsks } from '../core/fleet/lane-auth.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: phm fleet lane-auth [--json]\nReport lane sign-in state and record Asks cards for blocked lanes with unused plan.';

export async function cmdFleetLaneAuth(args: string[], deps: {
  read?: typeof readLaneAuth; raise?: typeof raiseLaneAuthAsks;
} = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(USAGE); return 2; }
  const runsDir = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  const report = await (deps.read ?? readLaneAuth)({ runsDir });
  await (deps.raise ?? raiseLaneAuthAsks)(report, { runsDir });
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(report)) : formatLaneAuthText(report));
  return 0;
}
