import { dirname, resolve } from 'node:path';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { parseBusEnvelope, MAX_BUS_ENVELOPE_BYTES } from '../core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { busStatusExitCode } from './comms-bus-exit.js';

const HELP = `phm comms bus post --file <envelope.json>
phm comms bus read [--after <cursor>] [--limit <n>]
phm comms bus watch [--after <cursor>] [--limit <n>] [--interval-ms <ms>]
Local JSON transport; no delivery handlers. Bodies are untrusted JSON data.
Post: {status,id,cursor}; read: {status,messages:[{cursor,receivedAt,envelope}],nextCursor}.
Cursor is a persistent integer, initially 0; resume using nextCursor (also skips expired records).
Limit: 1..100 (default 50). Store: 1 MiB / 1024 records, then full; no eviction.
TTL milliseconds from original receipt; receivedAt is epoch milliseconds. Read never renews TTL.
Watch polls immediately, then every interval (100..60000 ms, default 1000); each successful poll
emits one JSON page, including empty pages, and resumes from its emitted nextCursor.
Watch retries retryable contention after the interval; other failures emit their status and exit 1.
SIGINT, SIGTERM or an injected AbortSignal stops watch with exit 0. Invalid options exit 2.
Failures: {status:invalid|unavailable|retryable|full|conflict}; retryable means writer contention.`;

export interface CommsBusDependencies {
  signal?: AbortSignal;
  list?: typeof listBusInboxAfter;
  emit?: (json: string) => void;
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function watch(after: number, limit: number, interval: number, options: BusInboxOptions, deps: CommsBusDependencies): Promise<number> {
  const controller = new AbortController(), stop = (): void => controller.abort();
  const emit = deps.emit ?? console.log, list = deps.list ?? listBusInboxAfter;
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    while (!controller.signal.aborted) {
      const page = list(after, limit, options);
      if (controller.signal.aborted) break;
      if (page.status === 'ok') {
        emit(JSON.stringify(page));
        after = page.nextCursor;
      } else if (page.status !== 'retryable') {
        emit(JSON.stringify(page));
        return 1;
      }
      await waitForPoll(interval, controller.signal);
    }
    return 0;
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

export async function cmdCommsBus(args: string[], options: BusInboxOptions = {}, deps: CommsBusDependencies = {}): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
    args.length === 2 && ['post', 'read', 'watch'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
    console.log(HELP); return 0;
  }
  const [verb, ...rest] = args, values = new Map<string, string>();
  const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
  if (verb !== 'post' && verb !== 'read' && verb !== 'watch') return invalid();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!(verb === 'post' ? ['--file'] : verb === 'watch' ? ['--after', '--limit', '--interval-ms'] : ['--after', '--limit']).includes(key) || values.has(key) || !value || value.startsWith('-')) return invalid();
    values.set(key, value);
  }
  if (verb === 'post' && !values.has('--file')) return invalid();
  for (const key of ['--after', '--limit', '--interval-ms']) {
    const value = values.get(key);
    if (value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) return invalid();
  }
  const after = Number(values.get('--after') ?? 0), limit = Number(values.get('--limit') ?? 50);
  if (limit < 1 || limit > 100) return invalid();
  if (verb === 'watch') {
    const interval = Number(values.get('--interval-ms') ?? 1000);
    if (interval < 100 || interval > 60000) return invalid();
    return watch(after, limit, interval, options, deps);
  }
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
