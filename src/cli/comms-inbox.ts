import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { createChannelReceiver } from '../core/fleet/channel-envelope.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../core/fleet/mason-inbox.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { parseInboxReadQuery, projectInboxRead } from '../core/verse/fleet-inbox-read.js';

const HELP = `phm comms inbox read [--source <label>] [--contains <text>] [--limit <1..200>] [--json]
phm comms inbox post --file <text-file|-> [--json]
Reads and writes Mason's local inbox. Output is JSON; post returns the receiver acknowledgement.
Read options select the newest matching entries (default limit 50), returned oldest first; source is metadata, not identity.
--contains <text> is a literal case-insensitive substring match on message text (not regex) over the same bounded inbox tail, applied before the limit.
The local process owner is the trust boundary; this does not authenticate internet or email senders.
Input must be an owner-controlled stable regular UTF-8 text file, or stdin with --file - (maximum ${INBOX_MAX_CHARS} characters).
Duplicate receipts are retained only for the receiver's process lifetime.`;

// Identity is owned by this adapter, never derived from arguments or message content.
const LOCAL_OPERATOR = 'local-operator';
// A UTF-16 code unit can encode as at most three UTF-8 bytes.
const MAX_FILE_BYTES = INBOX_MAX_CHARS * 3;

async function readStdin(stream: Readable): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) return undefined;
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (bytes > MAX_FILE_BYTES) return undefined;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

export function createCommsInboxCommand(options: { runsDir?: string; stdin?: Readable } = {}): (args: string[]) => Promise<number> {
  const receive = createChannelReceiver({ allowedSenderIds: new Set([LOCAL_OPERATOR]), runsDir: options.runsDir });
  return async (args: string[]): Promise<number> => {
    if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
      args.length === 2 && ['read', 'post'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
      console.log(HELP); return 0;
    }
    const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
    const [verb, ...rest] = args;
    if (verb !== 'read' && verb !== 'post') return invalid();
    let file: string | undefined, json = false, contains: string | undefined;
    const queryParams = new URLSearchParams();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--file' && verb === 'post' && file === undefined) {
        const value = rest[++i];
        if (!value || value !== '-' && value.startsWith('-')) return invalid();
        file = value;
      } else if (verb === 'read' && (arg === '--source' || arg === '--limit')) {
        const key = arg.slice(2), value = rest[++i];
        if (value === undefined || ['--source', '--limit', '--json', '--file', '--help', '-h'].includes(value) || queryParams.has(key)) return invalid();
        queryParams.append(key, value);
      } else if (verb === 'read' && arg === '--contains') {
        const value = rest[++i];
        if (value === undefined || !value.trim() || contains !== undefined ||
          ['--source', '--limit', '--contains', '--json', '--file', '--help', '-h'].includes(value)) return invalid();
        contains = value;
      } else return invalid();
    }
    if (verb === 'post' && file === undefined) return invalid();
    if (verb === 'read') {
      const query = parseInboxReadQuery(queryParams);
      if ('error' in query) return invalid();
      // Read the bounded file tail before filtering, so other sources do not consume the requested limit.
      const result = await readInboxEntries(queryParams.size || contains !== undefined ? { ...options, limit: Number.MAX_SAFE_INTEGER } : options);
      let entries;
      if (contains !== undefined) {
        const needle = contains.toLowerCase();
        // Match on projected entries so redaction and the source filter still apply; the limit then keeps the newest matches.
        entries = projectInboxRead(result, { limit: Number.MAX_SAFE_INTEGER, source: query.source })!.entries
          .filter((entry) => entry.text.toLowerCase().includes(needle)).slice(-query.limit);
      } else {
        entries = queryParams.size ? projectInboxRead(result, query)!.entries : result.entries;
      }
      console.log(JSON.stringify({ ...result, entries }));
      return result.sourceState === 'degraded' ? 1 : 0;
    }
    let text: string;
    if (file === '-') {
      const input = await readStdin(options.stdin ?? process.stdin);
      if (input === undefined) {
        console.log(JSON.stringify({ ok: false, reason: 'stdin-unavailable' })); return 1;
      }
      text = input;
    } else {
      const path = resolve(file!);
      const input = readStableRegularFile(path, { anchorPath: dirname(path), maxFileBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES });
      if (!input.ok) {
        console.log(JSON.stringify({ ok: false, reason: 'file-unavailable' })); return 1;
      }
      text = input.text;
    }
    const result = await receive({ channel: 'cli', verifiedSenderId: LOCAL_OPERATOR, body: text });
    console.log(JSON.stringify(result.ok ? { ok: true, ack: result.ack } : result));
    return result.ok ? 0 : 1;
  };
}

export const cmdCommsInbox = createCommsInboxCommand();
