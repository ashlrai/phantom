/** `phm work state <id> [--json]`: the same one-state read as
 * `phm channels reply-state`, under the plain name chat replies refer to. */
import { cmdChannelsReplyState } from './channels-reply-state.js';

const USAGE = 'usage: phm work state <id> [--json]';

export async function cmdWork(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  if (args[0] !== 'state') { console.error(USAGE); return 2; }
  return cmdChannelsReplyState(args.slice(1));
}
