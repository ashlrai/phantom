/** `phm channels reply-state <request-id> [--json]`: the one state read every
 * channel adapter and agent uses before replying about a work item. Read-only. */
import { join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { readReplyState } from '../core/comms/reply-state.js';

const USAGE = 'usage: phm channels reply-state <request-id> [--json]';

export async function cmdChannelsReplyState(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  const id = rest[0];
  if (rest.length !== 1 || !id || id.startsWith('-') || !id.trim()) { console.error(USAGE); return 2; }
  const state = readReplyState(id, { root: join(ashlrHome(), 'fleet'), now: Date.now() });
  console.log(json ? JSON.stringify(state, null, 2) : `${state.text}\nEvidence as of: ${state.asOf}`);
  return 0;
}
