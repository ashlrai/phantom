import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { createChannelReceiver } from '../core/fleet/channel-envelope.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../core/fleet/mason-inbox.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { parseInboxReadQuery, projectInboxRead } from '../core/verse/fleet-inbox-read.js';

const HELP = `phm comms inbox read [--source <label>] [--after <RFC3339-with-zone>] [--limit <1..200>] [--json]
phm comms inbox post --file <text-file|-> [--json]
Reads and writes Mason's local inbox. Output is JSON; post returns the receiver acknowledgement.
Read options select the newest matching entries (default limit 50), returned oldest first; source is metadata, not identity.
--after selects timestamps strictly later than the instant and reports omittedUndated; inbox local times are Eastern.
Ambiguous or nonexistent Eastern times and unparseable timestamps count as undated.
The local process owner is the trust boundary; this does not authenticate internet or email senders.
Input must be an owner-controlled stable regular UTF-8 text file, or stdin with --file - (maximum ${INBOX_MAX_CHARS} characters).
Duplicate receipts are retained only for the receiver's process lifetime.`;

// Identity is owned by this adapter, never derived from arguments or message content.
const LOCAL_OPERATOR = 'local-operator';
// A UTF-16 code unit can encode as at most three UTF-8 bytes.
const MAX_FILE_BYTES = INBOX_MAX_CHARS * 3;

// Validate the calendar fields before Date.parse, which otherwise normalizes invalid dates.
type Instant = { seconds: number; fraction: string };
function rfc3339Instant(value: string): Instant | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, s, fraction = '', zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() ||
    Number(h) > 23 || Number(min) > 59 || Number(s) > 59 || zone === '-00:00' ||
    (zone!.toUpperCase() !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59))) return undefined;
  const milliseconds = Date.parse(`${y}-${m}-${d}T${h}:${min}:${s}${zone!.toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { seconds: milliseconds / 1000, fraction: fraction.replace(/0+$/, '') };
}

const easternClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const easternOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

function entryInstant(at: string): Instant | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at);
  if (!local) return rfc3339Instant(at);
  const [, year, month, day, hour, minute] = local;
  const wall = rfc3339Instant(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
  if (wall === undefined) return undefined;
  const wallMs = wall.seconds * 1000;
  const candidates = new Set<number>();
  // Sample both sides of a transition, then validate the round-trip in Eastern time.
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const offset = easternOffset.formatToParts(new Date(wallMs + delta)).find(part => part.type === 'timeZoneName')?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
    if (!match) continue;
    const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
    const candidate = wallMs - minutes * 60_000;
    const parts = easternClock.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find(item => item.type === type)?.value;
    if (`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}` === at) candidates.add(candidate);
  }
  return candidates.size === 1 ? { seconds: [...candidates][0]! / 1000, fraction: '' } : undefined;
}

function laterThan(left: Instant, right: Instant): boolean {
  if (left.seconds !== right.seconds) return left.seconds > right.seconds;
  const length = Math.max(left.fraction.length, right.fraction.length);
  return left.fraction.padEnd(length, '0') > right.fraction.padEnd(length, '0');
}

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
    let file: string | undefined, after: Instant | undefined, json = false;
    const queryParams = new URLSearchParams();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--file' && verb === 'post' && file === undefined) {
        const value = rest[++i];
        if (!value || value !== '-' && value.startsWith('-')) return invalid();
        file = value;
      } else if (verb === 'read' && arg === '--after' && after === undefined) {
        const value = rest[++i];
        if (value === undefined || (after = rfc3339Instant(value)) === undefined) return invalid();
      } else if (verb === 'read' && (arg === '--source' || arg === '--limit')) {
        const key = arg.slice(2), value = rest[++i];
        if (value === undefined || ['--source', '--limit', '--after', '--json', '--file', '--help', '-h'].includes(value) || queryParams.has(key)) return invalid();
        queryParams.append(key, value);
      } else return invalid();
    }
    if (verb === 'post' && file === undefined) return invalid();
    if (verb === 'read') {
      const query = parseInboxReadQuery(queryParams);
      if ('error' in query) return invalid();
      // Read the bounded file tail before filtering, so other sources do not consume the requested limit.
      const filtered = queryParams.size > 0 || after !== undefined;
      const result = await readInboxEntries(filtered ? { ...options, limit: Number.MAX_SAFE_INTEGER } : options);
      let omittedUndated = 0;
      const datedEntries = after === undefined ? result.entries : result.entries.filter(entry => {
        const instant = entryInstant(entry.at);
        if (instant === undefined) { omittedUndated++; return false; }
        return laterThan(instant, after!);
      });
      const entries = filtered ? projectInboxRead({ ...result, entries: datedEntries }, query)!.entries : result.entries;
      console.log(JSON.stringify({ ...result, entries, ...(after === undefined ? {} : { omittedUndated }) }));
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
