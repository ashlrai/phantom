import { dirname, resolve } from 'node:path';
import { createChannelReceiver } from '../core/fleet/channel-envelope.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../core/fleet/mason-inbox.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const HELP = `phm comms inbox read [--json]
phm comms inbox post --file <text-file> [--json]
Reads and writes Mason's local inbox. Output is JSON; post returns the receiver acknowledgement.
The local process owner is the trust boundary; this does not authenticate internet or email senders.
Input must be an owner-controlled stable regular UTF-8 text file (maximum ${INBOX_MAX_CHARS} characters).
Duplicate receipts are retained only for the receiver's process lifetime.`;

// Identity is owned by this adapter, never derived from arguments or message content.
const LOCAL_OPERATOR = 'local-operator';
// A UTF-16 code unit can encode as at most three UTF-8 bytes.
const MAX_FILE_BYTES = INBOX_MAX_CHARS * 3;

export function createCommsInboxCommand(options: { runsDir?: string } = {}): (args: string[]) => Promise<number> {
  const receive = createChannelReceiver({ allowedSenderIds: new Set([LOCAL_OPERATOR]), runsDir: options.runsDir });
  return async (args: string[]): Promise<number> => {
    if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
      args.length === 2 && ['read', 'post'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
      console.log(HELP); return 0;
    }
    const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
    const [verb, ...rest] = args;
    if (verb !== 'read' && verb !== 'post') return invalid();
    let file: string | undefined, json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--file' && verb === 'post' && file === undefined) {
        const value = rest[++i];
        if (!value || value.startsWith('-')) return invalid();
        file = value;
      } else return invalid();
    }
    if (verb === 'post' && file === undefined) return invalid();
    if (verb === 'read') {
      const result = await readInboxEntries(options);
      console.log(JSON.stringify(result));
      return result.sourceState === 'degraded' ? 1 : 0;
    }
    const path = resolve(file!);
    const input = readStableRegularFile(path, { anchorPath: dirname(path), maxFileBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES });
    if (!input.ok) {
      console.log(JSON.stringify({ ok: false, reason: 'file-unavailable' })); return 1;
    }
    const result = await receive({ channel: 'cli', verifiedSenderId: LOCAL_OPERATOR, body: input.text });
    console.log(JSON.stringify(result.ok ? { ok: true, ack: result.ack } : result));
    return result.ok ? 0 : 1;
  };
}

export const cmdCommsInbox = createCommsInboxCommand();
