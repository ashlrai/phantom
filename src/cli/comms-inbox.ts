import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createChannelReceiver } from '../core/fleet/channel-envelope.js';
import { INBOX_MAX_CHARS, readInboxEntries } from '../core/fleet/mason-inbox.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { parseInboxReadQuery, projectInboxRead } from '../core/verse/fleet-inbox-read.js';

const HELP = `phm comms inbox read [--source <label>] [--contains <text>] [--priority <P0|P1|P2|P3>] [--after <RFC3339-with-zone>] [--before <RFC3339-with-zone>] [--limit <1..200>] [--watch [--interval-ms <1000..60000>] [--max-samples <1..10000>]] [--json]
phm comms inbox post --file <text-file|-> [--receipt-only] [--json]
Reads and writes Mason's local inbox. Output is JSON; post returns the receiver acknowledgement.
--receipt-only on post returns only the acknowledgement status, channel and durable deduplication key, or a failure reason; it excludes message text and private paths.
Read options select the newest matching entries (default limit 50), returned oldest first; source is metadata, not identity.
--contains <text> is a literal case-insensitive substring match on message text (not regex) over the same bounded inbox tail, applied before the limit.
--priority selects entries with exactly that priority; entries without a priority do not match.
--after and --before select timestamps strictly inside the supplied bounds and report omittedUndated; inbox local times are Eastern.
When both are supplied, --after must be earlier than --before.
Ambiguous or nonexistent Eastern times and unparseable timestamps count as undated.
--watch emits complete snapshots immediately and after each interval (default 1000 ms); stop with SIGINT or SIGTERM.
Snapshots can repeat entries and do not provide a delivery cursor.
The local process owner is the trust boundary; this does not authenticate internet or email senders.
Input must be an owner-controlled stable regular UTF-8 text file, or stdin with --file - (maximum ${INBOX_MAX_CHARS} characters).
Default duplicate receipts persist across receiver restarts in the shared runs context.`;

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

type WatchSignal = 'SIGINT' | 'SIGTERM';
type SignalSource = {
  on: (event: WatchSignal, listener: () => void) => unknown;
  off: (event: WatchSignal, listener: () => void) => unknown;
};
type CommandOptions = {
  runsDir?: string;
  stdin?: Readable;
  signals?: SignalSource;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function createCommsInboxCommand(options: CommandOptions = {}): (args: string[]) => Promise<number> {
  const receive = createChannelReceiver({ allowedSenderIds: new Set([LOCAL_OPERATOR]), runsDir: options.runsDir });
  return async (args: string[]): Promise<number> => {
    if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
      args.length === 2 && ['read', 'post'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
      console.log(HELP); return 0;
    }
    const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
    const [verb, ...rest] = args;
    if (verb !== 'read' && verb !== 'post') return invalid();
    let file: string | undefined, after: Instant | undefined, before: Instant | undefined, priority: string | undefined, contains: string | undefined, json = false, watch = false, receiptOnly = false;
    let intervalMs: number | undefined, maxSamples: number | undefined;
    const queryParams = new URLSearchParams();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--json' && !json) json = true;
      else if (verb === 'post' && arg === '--receipt-only' && !receiptOnly) receiptOnly = true;
      else if (verb === 'read' && arg === '--watch' && !watch) watch = true;
      else if (verb === 'read' && (arg === '--interval-ms' || arg === '--max-samples')) {
        const value = rest[++i];
        const number = Number(value);
        const maximum = arg === '--interval-ms' ? 60_000 : 10_000;
        const minimum = arg === '--interval-ms' ? 1_000 : 1;
        if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum ||
          (arg === '--interval-ms' ? intervalMs !== undefined : maxSamples !== undefined)) return invalid();
        if (arg === '--interval-ms') intervalMs = number;
        else maxSamples = number;
      }
      else if (arg === '--file' && verb === 'post' && file === undefined) {
        const value = rest[++i];
        if (!value || value !== '-' && value.startsWith('-')) return invalid();
        file = value;
      } else if (verb === 'read' && arg === '--after' && after === undefined) {
        const value = rest[++i];
        if (value === undefined || (after = rfc3339Instant(value)) === undefined) return invalid();
      } else if (verb === 'read' && arg === '--before' && before === undefined) {
        const value = rest[++i];
        if (value === undefined || (before = rfc3339Instant(value)) === undefined) return invalid();
      } else if (verb === 'read' && arg === '--priority' && priority === undefined) {
        const value = rest[++i];
        if (value === undefined || !/^P[0-3]$/.test(value)) return invalid();
        priority = value;
      } else if (verb === 'read' && (arg === '--source' || arg === '--limit')) {
        const key = arg.slice(2), value = rest[++i];
        if (value === undefined || ['--source', '--limit', '--contains', '--priority', '--after', '--before', '--watch', '--interval-ms', '--max-samples', '--json', '--receipt-only', '--file', '--help', '-h'].includes(value) || queryParams.has(key)) return invalid();
        queryParams.append(key, value);
      } else if (verb === 'read' && arg === '--contains' && contains === undefined) {
        const value = rest[++i];
        if (value === undefined || !value.trim() ||
          ['--source', '--limit', '--contains', '--priority', '--after', '--before', '--watch', '--interval-ms', '--max-samples', '--json', '--receipt-only', '--file', '--help', '-h'].includes(value)) return invalid();
        contains = value;
      } else return invalid();
    }
    if (verb === 'post' && file === undefined) return invalid();
    if (verb === 'read') {
      if (after !== undefined && before !== undefined && !laterThan(before, after)) return invalid();
      if (!watch && (intervalMs !== undefined || maxSamples !== undefined)) return invalid();
      const query = parseInboxReadQuery(queryParams);
      if ('error' in query) return invalid();
      // Read the bounded file tail before filtering, so other sources do not consume the requested limit.
      const needle = contains === undefined ? undefined : contains.toLowerCase();
      const readSnapshot = async () => {
        const result = await readInboxEntries({ runsDir: options.runsDir, limit: Number.MAX_SAFE_INTEGER });
        let omittedUndated = 0;
        const datedEntries = after === undefined && before === undefined ? result.entries : result.entries.filter(entry => {
          const instant = entryInstant(entry.at);
          if (instant === undefined) { omittedUndated++; return false; }
          return (after === undefined || laterThan(instant, after)) && (before === undefined || laterThan(before, instant));
        });
        const matchingEntries = priority === undefined ? datedEntries : datedEntries.filter(entry => entry.priority === priority);
        // Match on projected entries so redaction and the source filter still apply; the limit then keeps the newest matches.
        const projected = projectInboxRead({ ...result, entries: matchingEntries },
          needle === undefined ? query : { ...query, limit: Number.MAX_SAFE_INTEGER })!.entries;
        const entries = needle === undefined ? projected
          : projected.filter(entry => entry.text.toLowerCase().includes(needle)).slice(-query.limit);
        return { ...result, entries, ...(after === undefined && before === undefined ? {} : { omittedUndated }) };
      };
      if (!watch) {
        const result = await readSnapshot();
        console.log(JSON.stringify(result));
        return result.sourceState === 'degraded' ? 1 : 0;
      }
      const controller = new AbortController();
      const signals = options.signals ?? process;
      const stop = (): void => controller.abort();
      signals.on('SIGINT', stop);
      signals.on('SIGTERM', stop);
      try {
        for (let samples = 0; !controller.signal.aborted && (maxSamples === undefined || samples < maxSamples); samples++) {
          const result = await readSnapshot();
          if (controller.signal.aborted) break;
          console.log(JSON.stringify(result));
          if (result.sourceState === 'degraded') return 1;
          if (maxSamples !== undefined && samples + 1 >= maxSamples) break;
          try {
            await (options.wait ?? ((ms, signal) => delay(ms, undefined, { signal })))(intervalMs ?? 1000, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          }
        }
        return 0;
      } finally {
        signals.off('SIGINT', stop);
        signals.off('SIGTERM', stop);
      }
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
    const output = receiptOnly
      ? result.ok
        ? { ok: true, ack: { channel: result.ack.channel, dedupeKey: result.ack.dedupeKey, status: result.ack.status } }
        : { ok: false, reason: result.reason }
      : result.ok ? { ok: true, ack: result.ack } : result;
    console.log(JSON.stringify(output));
    return result.ok ? 0 : 1;
  };
}

export const cmdCommsInbox = createCommsInboxCommand();
