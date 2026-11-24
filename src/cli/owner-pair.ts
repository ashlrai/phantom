/**
 * `phm owner pair imessage [--handle H] [--json]`, `phm owner pair status [--json]`,
 * `phm owner unpair imessage [--json]`. Thin: parses argv and calls
 * src/core/comms/owner-pair.ts. Pairing needs at most one word from Mason: YES.
 */
import { loadConfigAt } from '../core/config.js';
import { fixedOwnerConfigDir } from '../core/comms/owner-channel.js';
import { checkOwnerPair, loopbackPairBridge, readOwnerPairStatus, startOwnerPair, unpairOwner, type PairDeps } from '../core/comms/owner-pair.js';

export const OWNER_PAIR_USAGE = 'Usage: phm owner pair imessage [--handle <handle>] [--json]\n       phm owner pair status [--json]\n       phm owner unpair imessage [--json]';

export interface OwnerPairCliDeps {
  /** Tests pass a temp config dir and a fake bridge; production uses the real owner home and the loopback bridge. */
  pair?: PairDeps;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

const MESSAGES: Record<string, string> = {
  'already-paired': 'Already paired. To change it: phm owner unpair imessage',
  'already-pending': 'Already waiting for your YES. Reply YES to the text on your phone.',
  'too-soon': 'A pairing text went out in the last 24 hours.',
  'none-found': 'No iMessage account found on this Mac. Run: phm owner pair imessage --handle <your iMessage address>',
  'send-failed': 'The pairing text did not send. Check that Messages is signed in, then run it again.',
  'messages-unreadable': 'Messages is not readable. Give your terminal Full Disk Access, then run it again.',
  'bad-handle': 'That handle has characters an iMessage address does not use. Use letters, digits and @ . _ + - only.',
};

export async function cmdOwnerPair(args: string[], deps: OwnerPairCliDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.some(a => a === '--help' || a === '-h')) { output(OWNER_PAIR_USAGE); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (args.filter(a => a === '--json').length > 1) { error(OWNER_PAIR_USAGE); return 2; }
  const pairDeps = (): PairDeps => deps.pair ?? { configDir: fixedOwnerConfigDir(), bridge: loopbackPairBridge(loadConfigAt(fixedOwnerConfigDir())) };
  const configDir = deps.pair?.configDir ?? fixedOwnerConfigDir();
  const emit = (value: Record<string, unknown>, line: string): void => output(json ? JSON.stringify({ schema: 'owner-pair.v1', ...value }) : line);

  if (rest[0] === 'pair' && rest[1] === 'status' && rest.length === 2) {
    const status = readOwnerPairStatus(configDir);
    output(json ? JSON.stringify(status) : status.line);
    return 0;
  }
  if (rest[0] === 'unpair' && rest[1] === 'imessage' && rest.length === 2) {
    const result = unpairOwner(configDir);
    emit({ status: result.status }, result.status === 'unpaired' ? 'iMessage unpaired. Pair again: phm owner pair imessage'
      : result.status === 'not-paired' ? 'Not paired.' : 'Could not remove the iMessage binding safely; agent-network.toml was left as it was.');
    return result.status === 'failed' ? 1 : 0;
  }
  if (rest[0] === 'pair' && rest[1] === 'imessage') {
    let handle: string | undefined;
    const tail = rest.slice(2);
    if (tail.length === 2 && tail[0] === '--handle') handle = tail[1];
    else if (tail.length !== 0) { error(OWNER_PAIR_USAGE); return 2; }
    const live = pairDeps();
    // A waiting pair is checked first, so running this again after replying YES finishes the pairing.
    if (handle === undefined) {
      const checked = await checkOwnerPair(live);
      if (checked.status === 'bound') {
        emit({ status: 'paired', confirmed: checked.confirmed, ...(checked.reason ? { reason: checked.reason } : {}) },
          `Paired. ${checked.confirmed ? 'Fleet updates will come here.' : `Not confirmed yet: ${checked.reason ?? 'see comms.toml'}`}`);
        return 0;
      }
    }
    const started = await startOwnerPair(live, handle === undefined ? {} : { handle });
    if (started.status === 'pending') {
      const n = started.handles.length;
      emit({ status: 'pending', sent: n, since: new Date(started.since).toISOString() },
        `Sent a text to ${n} handle${n === 1 ? '' : 's'} (${started.handles.map(h => '**' + h.slice(-2)).join(', ')}). Reply YES on your phone. It waits 24 hours.`);
      return 0;
    }
    emit({ status: started.status }, MESSAGES[started.status] ?? started.status);
    return started.status === 'already-paired' || started.status === 'already-pending' || started.status === 'too-soon' ? 0 : 1;
  }
  error(OWNER_PAIR_USAGE);
  return 2;
}
