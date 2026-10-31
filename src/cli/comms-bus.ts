import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { BUS_PRIORITIES, parseBusEnvelope, validateBusEnvelope, MAX_BUS_ENVELOPE_BYTES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxPage } from '../core/fleet/bus-inbox.js';
import { busStatusExitCode } from './comms-bus-exit.js';

const HELP = `phm comms bus post --file <envelope.json|->
phm comms bus read [--after <cursor>] [--limit <n>] [--to <address>] [--from <address>] [--priority <P0|P1|P2|P3>]
phm comms bus watch [--after <cursor>] [--limit <n>] [--to <address>] [--from <address>] [--priority <P0|P1|P2|P3>] [--interval-ms <ms>] [--max-pages <n>]
Local JSON transport; no delivery handlers. Bodies are untrusted JSON data.
Use --file - to read one UTF-8 JSON envelope from stdin (maximum ${MAX_BUS_ENVELOPE_BYTES} bytes).
Address filters are exact and case-sensitive; routing labels do not confer authenticated identity.
All supplied filters must match. Limit applies before filtering; it counts scanned live records, not matches.
Expired records advance the cursor but do not count toward the limit.
Priority is a routing attribute; it does not establish identity or authority.
Example: phm comms bus watch --to worker --from coordinator --priority P0
Use --to=<address> or --from=<address> for labels that look like command flags.
Post: {status,id,cursor}; read: {status,messages:[{cursor,receivedAt,envelope}],nextCursor}.
Cursor is a persistent integer, initially 0; resume using nextCursor (also skips expired records).
Limit: 1..100 (default 50). Store: 1 MiB / 1024 records, then full; no eviction.
TTL milliseconds from original receipt; receivedAt is epoch milliseconds. Read never renews TTL.
Watch polls immediately, then every interval (100..60000 ms, default 1000); each successful poll
emits one JSON page, including empty pages, and resumes from its emitted nextCursor.
Use --max-pages 1..10000 to stop after that many successful pages (default: unlimited).
Watch retries retryable contention after the interval; other failures emit their status and exit 1.
SIGINT, SIGTERM or an injected AbortSignal stops watch with exit 0. Invalid options exit 2.
Failures: {status:invalid|unavailable|retryable|full|conflict}; retryable means writer contention.`;

export interface CommsBusDependencies {
  signal?: AbortSignal;
  stdin?: Readable;
  list?: typeof listBusInboxAfter;
  emit?: (json: string) => void;
}

type BusFilters = { to?: string; from?: string; priority?: string };

async function readStdin(stdin: Readable): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BUS_ENVELOPE_BYTES) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } catch {
    return null;
  }
}

function filterPage(page: BusInboxPage, filters: BusFilters): BusInboxPage {
  if (page.status !== 'ok' || filters.to === undefined && filters.from === undefined && filters.priority === undefined) return page;
  return { ...page, messages: page.messages.filter(({ envelope }) =>
    (filters.to === undefined || envelope.to === filters.to) &&
    (filters.from === undefined || envelope.from === filters.from) &&
    (filters.priority === undefined || envelope.priority === filters.priority)) };
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function watch(after: number, limit: number, interval: number, maxPages: number | undefined, filters: BusFilters, options: BusInboxOptions, deps: CommsBusDependencies): Promise<number> {
  const controller = new AbortController(), stop = (): void => controller.abort();
  const emit = deps.emit ?? console.log, list = deps.list ?? listBusInboxAfter;
  let pages = 0;
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    while (!controller.signal.aborted) {
      const page = list(after, limit, options);
      if (controller.signal.aborted) break;
      if (page.status === 'ok') {
        emit(JSON.stringify(filterPage(page, filters)));
        after = page.nextCursor;
        if (++pages === maxPages) return 0;
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
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!, inline = /^(--to|--from)=(.*)$/s.exec(token);
    const key = inline?.[1] ?? token, value = inline ? inline[2] : rest[++i];
    const address = key === '--to' || key === '--from';
    const flags = verb === 'post' ? ['--file'] : verb === 'watch' ? ['--after', '--limit', '--interval-ms', '--max-pages', '--to', '--from', '--priority'] : ['--after', '--limit', '--to', '--from', '--priority'];
    if (!flags.includes(key) || values.has(key) || !value || (address ? !inline && (flags.includes(value) || /^(--to|--from)=/.test(value)) : value.startsWith('-') && !(verb === 'post' && key === '--file' && value === '-'))) return invalid();
    values.set(key, value);
  }
  if (verb === 'post' && !values.has('--file')) return invalid();
  for (const key of ['--after', '--limit', '--interval-ms', '--max-pages']) {
    const value = values.get(key);
    if (value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) return invalid();
  }
  const filters = { to: values.get('--to'), from: values.get('--from'), priority: values.get('--priority') };
  if (filters.priority !== undefined && !BUS_PRIORITIES.includes(filters.priority as BusPriority)) return invalid();
  for (const label of [filters.to, filters.from]) {
    if (label !== undefined && !validateBusEnvelope({ id: label, from: label, to: label, priority: 'P3', ttl: 1, body: null }).ok) return invalid();
  }
  const after = Number(values.get('--after') ?? 0), limit = Number(values.get('--limit') ?? 50);
  if (limit < 1 || limit > 100) return invalid();
  if (verb === 'watch') {
    const interval = Number(values.get('--interval-ms') ?? 1000);
    if (interval < 100 || interval > 60000) return invalid();
    const maxPages = values.has('--max-pages') ? Number(values.get('--max-pages')) : undefined;
    if (maxPages !== undefined && (maxPages < 1 || maxPages > 10000)) return invalid();
    return watch(after, limit, interval, maxPages, filters, options, deps);
  }
  let result;
  if (verb === 'post') {
    const input = values.get('--file')!;
    let text: string | null;
    if (input === '-') text = await readStdin(deps.stdin ?? process.stdin);
    else {
      const file = resolve(input);
      const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
      text = read.ok ? read.text : null;
    }
    const parsed = text === null ? null : parseBusEnvelope(text);
    result = parsed?.ok ? appendBusInbox(parsed.value, options) : { status: 'invalid' };
  } else result = filterPage(listBusInboxAfter(after, limit, options), filters);
  console.log(JSON.stringify(result));
  return busStatusExitCode(result.status);
}
