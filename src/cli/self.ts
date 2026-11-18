/** `phm self drift`: thin handler. Parses argv and prints the report built in core/release/drift.ts. */
import { formatSelfDrift, readSelfDrift, SELF_DRIFT_SCHEMA, type SelfDriftV1 } from '../core/release/drift.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const SELF_USAGE = `Usage: phm self drift [--json] [--repo <phantom clone>]
Is the running Phantom build behind the latest release and master, and which merged fleet fixes
(queue, dispatch, recut, precheck, router, yield, leader) are not live in it yet? Read-only, no network.
  --json           print the typed report (schema ${SELF_DRIFT_SCHEMA}, version 1)
  --repo <dir>     Phantom clone to read tags and master from (default: the checkout this build runs from)
Anything that cannot be read prints as unknown, never guessed. Exit 0 report, 2 bad usage.`;

export async function cmdSelf(args: string[], read: (repo?: string) => Promise<SelfDriftV1> = repo => readSelfDrift({ repo })): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(SELF_USAGE); return 0; }
  if (args[0] !== 'drift') { console.error(SELF_USAGE); return 2; }
  let json = false, repo: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--repo' && repo === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) repo = args[++i];
    else { console.error(SELF_USAGE); return 2; }
  }
  const drift = await read(repo);
  if (json) console.log(JSON.stringify(sanitizePublicJson(drift)));
  else process.stdout.write(formatSelfDrift(drift));
  return 0;
}
