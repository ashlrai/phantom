/** `phm app steer`: send one message to the leader agents (thin; logic in core/fleet/app-steer.ts). */
import { steerLeaders } from '../core/fleet/app-steer.js';
import { INBOX_MAX_CHARS } from '../core/fleet/mason-inbox.js';

const USAGE = `Usage: phm app steer --text <message> [--json]
Sends one message to the leader agents through Mason's inbox (the same path as the steer box in the app).
Messages are scrubbed for secret shapes and deduplicated. Maximum ${INBOX_MAX_CHARS} characters.
Example: phm app steer --text "Pause new PRs on phantom until CI is green" --json
Exit 0 accepted or duplicate, 1 refused, 2 invalid arguments.`;

export async function cmdApp(args: string[], options: { runsDir?: string } = {}): Promise<number> {
  if (args.length === 0 || args.some((a) => a === '--help' || a === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const [verb, ...rest] = args;
  let text: string | undefined;
  let json = false;
  for (let i = 0; verb === 'steer' && i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--text' && text === undefined && rest[i + 1] !== undefined) text = rest[++i];
    else { text = undefined; break; }
  }
  if (verb !== 'steer' || text === undefined || !text.trim()) {
    if (json) console.log(JSON.stringify({ ok: false, reason: 'invalid' }));
    else console.error(`error: invalid app arguments\n${USAGE}`);
    return 2;
  }
  const result = await steerLeaders(text, options);
  if (json) console.log(JSON.stringify(result));
  else if (result.ok) console.log(result.status === 'accepted' ? 'Sent to the leaders.' : 'Already sent in the last 10 minutes.');
  else console.error(`error: not sent (${result.reason})`);
  return result.ok ? 0 : 1;
}
