import { dirname, resolve } from 'node:path';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { parseBusEnvelope, MAX_BUS_ENVELOPE_BYTES } from '../core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { busStatusExitCode } from './comms-bus-exit.js';

const HELP = `phm comms bus post --file <envelope.json>
phm comms bus read [--after <cursor>] [--limit <n>]
Local JSON transport; no delivery handlers. Bodies are untrusted JSON data.
Post: {status,id,cursor}; read: {status,messages:[{cursor,receivedAt,envelope}],nextCursor}.
Cursor is a persistent integer, initially 0; resume using nextCursor (also skips expired records).
Limit: 1..100 (default 50). Store: 1 MiB / 1024 records, then full; no eviction.
TTL milliseconds from original receipt; receivedAt is epoch milliseconds. Read never renews TTL.
Failures: {status:invalid|unavailable|retryable|full|conflict}; retryable means writer contention.`;
export async function cmdCommsBus(args: string[], options: BusInboxOptions = {}): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
    args.length === 2 && ['post', 'read'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
    console.log(HELP); return 0;
  }
  const [verb, ...rest] = args, values = new Map<string, string>();
  const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
  if (verb !== 'post' && verb !== 'read') return invalid();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!(verb === 'post' ? ['--file'] : ['--after', '--limit']).includes(key) || values.has(key) || !value || value.startsWith('-')) return invalid();
    values.set(key, value);
  }
  if (verb === 'post' && !values.has('--file')) return invalid();
  for (const key of ['--after', '--limit']) {
    const value = values.get(key);
    if (value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) return invalid();
  }
  const after = Number(values.get('--after') ?? 0), limit = Number(values.get('--limit') ?? 50);
  if (limit < 1 || limit > 100) return invalid();
  let result;
  if (verb === 'post') {
    const file = resolve(values.get('--file')!);
    const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
    const parsed = read.ok ? parseBusEnvelope(read.text) : null;
    result = parsed?.ok ? appendBusInbox(parsed.value, options) : { status: 'invalid' };
  } else result = listBusInboxAfter(after, limit, options);
  console.log(JSON.stringify(result));
  return busStatusExitCode(result.status);
}
