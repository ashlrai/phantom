import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { BUS_PRIORITIES, parseBusEnvelope, validateBusEnvelope, MAX_BUS_ENVELOPE_BYTES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { appendBusInbox, inspectBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxPage } from '../core/fleet/bus-inbox.js';
import { openBusCheckpoint } from './comms-bus-checkpoint.js';
import { busStatusExitCode } from './comms-bus-exit.js';

const HELP = `phm comms bus post --file <envelope.json|->
phm comms bus status
phm comms bus read [--after <cursor> | --checkpoint <absolute-path>] [--limit <n>] [--id <id>] [--in-reply-to <id>] [--to <address>] [--from <address>] [--exclude-from <address>] [--priority <P0|P1|P2|P3>]
phm comms bus watch [--after <cursor> | --checkpoint <absolute-path>] [--limit <n>] [--id <id>] [--in-reply-to <id>] [--to <address>] [--from <address>] [--exclude-from <address>] [--priority <P0|P1|P2|P3>] [--interval-ms <ms>] [--max-pages <n>] [--timeout-ms <ms>]
Local JSON transport; no delivery handlers. Bodies are untrusted JSON data.
Use --file - to read one UTF-8 JSON envelope from stdin (maximum ${MAX_BUS_ENVELOPE_BYTES} bytes).
Address filters are exact and case-sensitive; routing labels do not confer authenticated identity.
--exclude-from omits envelopes with that sender routing label.
ID filters match envelope IDs exactly and case-sensitively; IDs are transport data, not authentication.
--in-reply-to matches an object's own string body.inReplyTo exactly and case-sensitively.
This is an application convention, not an envelope field or authenticated identity.
All supplied filters must match. Limit applies before filtering; it counts scanned live records, not matches.
Expired records advance the cursor but do not count toward the limit.
Priority is a routing attribute; it does not establish identity or authority.
Example: phm comms bus watch --to worker --from coordinator --priority P0
Request/reply example: a reply body {"inReplyTo":"request-1"} matches phm comms bus read --in-reply-to request-1
Use --id=<id>, --in-reply-to=<id>, --to=<address>, --from=<address> or --exclude-from=<address> for values that look like command flags.
Post: {status,id,cursor}; read: {status,messages:[{cursor,receivedAt,envelope}],nextCursor}.
Cursor is a persistent integer, initially 0; resume using nextCursor (also skips expired records).
--checkpoint stores only version, scan cursor and canonical filters in an existing private directory.
Missing state starts at zero; corrupt state or changed filters fail. Use one consumer per checkpoint.
Checkpoint advances after stdout delivery, including empty filtered pages. A crash between stdout
and persistence can replay a page: at-least-once delivery, without handler acknowledgements.
Limit: 1..100 (default 50). Store: 1 MiB / 1024 records, then full; no eviction.
Status reports metadata only; expired records still occupy retained capacity. It never resets cursors.
Missing or unavailable stores have unknown counts and bytes (null); unavailable exits 1.
TTL milliseconds from original receipt; receivedAt is epoch milliseconds. Read never renews TTL.
Watch polls immediately, then every interval (100..60000 ms, default 1000); each successful poll
emits one JSON page, including empty pages, and resumes from its emitted nextCursor.
Use --max-pages 1..10000 to stop after that many successful pages (default: unlimited).
Use --timeout-ms 1..3600000 to bound observation time (default: unlimited). Reaching the
deadline completes observation successfully; it does not guarantee a reply.
Watch retries retryable contention after the interval; other failures emit their status and exit 1.
SIGINT, SIGTERM or an injected AbortSignal stops watch with exit 0. Invalid options exit 2.
An already-started delivery must settle before watch stops; cancellation cannot undo delivered data.
Rejected asynchronous delivery stops watch with exit 1 without advancing its cursor.
Failures: {status:invalid|unavailable|retryable|full|conflict}; retryable means writer contention.`;

export interface CommsBusDependencies {
  signal?: AbortSignal;
  stdin?: Readable;
  list?: typeof listBusInboxAfter;
  emit?: (json: string) => void | Promise<void>;
}

type BusFilters = { id?: string; inReplyTo?: string; to?: string; from?: string; excludeFrom?: string; priority?: string };

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
  if (page.status !== 'ok' || filters.id === undefined && filters.inReplyTo === undefined && filters.to === undefined && filters.from === undefined && filters.excludeFrom === undefined && filters.priority === undefined) return page;
  return { ...page, messages: page.messages.filter(({ envelope }) =>
    (filters.id === undefined || envelope.id === filters.id) &&
    (filters.inReplyTo === undefined || envelope.body !== null && typeof envelope.body === 'object' &&
      !Array.isArray(envelope.body) && Object.hasOwn(envelope.body, 'inReplyTo') && envelope.body.inReplyTo === filters.inReplyTo) &&
    (filters.to === undefined || envelope.to === filters.to) &&
    (filters.from === undefined || envelope.from === filters.from) &&
    (filters.excludeFrom === undefined || envelope.from !== filters.excludeFrom) &&
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

function deliver(json: string, deps: CommsBusDependencies, checkpoint?: ReturnType<typeof openBusCheckpoint>): void | Promise<void> {
  if (deps.emit) return deps.emit(json);
  if (!checkpoint) { console.log(json); return; }
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => { reject(error); };
    process.stdout.once('error', fail);
    try {
      process.stdout.write(json + '\n', error => {
        if (error) reject(error); else resolve();
        // Keep the error listener through the write error event.
        setImmediate(() => process.stdout.off('error', fail));
      });
    } catch (error) {
      process.stdout.off('error', fail);
      reject(error);
    }
  });
}

async function watch(after: number, limit: number, interval: number, maxPages: number | undefined, timeout: number | undefined, filters: BusFilters, options: BusInboxOptions, deps: CommsBusDependencies, checkpoint?: ReturnType<typeof openBusCheckpoint>): Promise<number> {
  const controller = new AbortController(), stop = (): void => controller.abort();
  const list = deps.list ?? listBusInboxAfter;
  const deliverPage = (json: string): void | Promise<boolean> => {
    const pending = deliver(json, deps, checkpoint);
    if (pending && typeof pending.then === 'function') {
      return pending.then(() => true, () => { console.error('bus watch: delivery failed'); return false; });
    }
  };
  const deadline = timeout === undefined ? undefined : performance.now() + timeout;
  const expired = (): boolean => deadline !== undefined && performance.now() >= deadline;
  const timer = timeout === undefined ? undefined : setTimeout(stop, timeout);
  let pages = 0;
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    while (!controller.signal.aborted && !expired()) {
      const page = list(after, limit, options);
      if (controller.signal.aborted) break;
      if (page.status !== 'ok' && page.status !== 'retryable') {
        if (!expired()) {
          const pending = deliverPage(JSON.stringify(page));
          if (pending) await pending;
        }
        return 1;
      }
      if (expired()) break;
      if (page.status === 'ok') {
        const output = JSON.stringify(filterPage(page, filters));
        if (expired()) break;
        const pending = deliverPage(output);
        if (pending && !await pending) return 1;
        checkpoint?.save(page.nextCursor);
        after = page.nextCursor;
        if (++pages === maxPages) return 0;
      }
      await waitForPoll(interval, controller.signal);
    }
    return 0;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

export async function cmdCommsBus(args: string[], options: BusInboxOptions = {}, deps: CommsBusDependencies = {}): Promise<number> {
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0]!) ||
    args.length === 2 && ['post', 'read', 'watch', 'status'].includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
    console.log(HELP); return 0;
  }
  const [verb, ...rest] = args, values = new Map<string, string>();
  const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
  if (verb === 'status') {
    if (rest.length !== 0) return invalid();
    const inspection = inspectBusInbox(options);
    console.log(JSON.stringify(inspection));
    return inspection.source === 'unavailable' ? 1 : 0;
  }
  if (verb !== 'post' && verb !== 'read' && verb !== 'watch') return invalid();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!, inline = /^(--id|--in-reply-to|--to|--from|--exclude-from)=(.*)$/s.exec(token);
    const key = inline?.[1] ?? token, value = inline ? inline[2] : rest[++i];
    const label = key === '--id' || key === '--in-reply-to' || key === '--to' || key === '--from' || key === '--exclude-from';
    const flags = verb === 'post' ? ['--file'] : verb === 'watch' ? ['--checkpoint', '--after', '--limit', '--interval-ms', '--max-pages', '--timeout-ms', '--id', '--in-reply-to', '--to', '--from', '--exclude-from', '--priority'] : ['--checkpoint', '--after', '--limit', '--id', '--in-reply-to', '--to', '--from', '--exclude-from', '--priority'];
    if (!flags.includes(key) || values.has(key) || !value || (label ? !inline && (flags.includes(value) || /^(--id|--in-reply-to|--to|--from|--exclude-from)=/.test(value)) : value.startsWith('-') && !(verb === 'post' && key === '--file' && value === '-'))) return invalid();
    values.set(key, value);
  }
  if (verb === 'post' && !values.has('--file')) return invalid();
  for (const key of ['--after', '--limit', '--interval-ms', '--max-pages', '--timeout-ms']) {
    const value = values.get(key);
    if (value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))) return invalid();
  }
  const filters = { id: values.get('--id'), inReplyTo: values.get('--in-reply-to'), to: values.get('--to'), from: values.get('--from'), excludeFrom: values.get('--exclude-from'), priority: values.get('--priority') };
  if (filters.priority !== undefined && !BUS_PRIORITIES.includes(filters.priority as BusPriority)) return invalid();
  for (const label of [filters.id, filters.inReplyTo, filters.to, filters.from, filters.excludeFrom]) {
    if (label !== undefined && !validateBusEnvelope({ id: label, from: label, to: label, priority: 'P3', ttl: 1, body: null }).ok) return invalid();
  }
  if (values.has('--checkpoint') && values.has('--after')) return invalid();
  let after = Number(values.get('--after') ?? 0);
  const limit = Number(values.get('--limit') ?? 50);
  if (limit < 1 || limit > 100) return invalid();
  let checkpoint: ReturnType<typeof openBusCheckpoint> | undefined;
  try {
    if (values.has('--checkpoint')) {
      checkpoint = openBusCheckpoint(values.get('--checkpoint')!, filters);
      after = checkpoint.cursor;
    }
    if (verb === 'watch') {
      const interval = Number(values.get('--interval-ms') ?? 1000);
      if (interval < 100 || interval > 60000) return invalid();
      const maxPages = values.has('--max-pages') ? Number(values.get('--max-pages')) : undefined;
      if (maxPages !== undefined && (maxPages < 1 || maxPages > 10000)) return invalid();
      const timeout = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : undefined;
      if (timeout !== undefined && (timeout < 1 || timeout > 3600000)) return invalid();
      return await watch(after, limit, interval, maxPages, timeout, filters, options, deps, checkpoint);
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
    } else result = filterPage((deps.list ?? listBusInboxAfter)(after, limit, options), filters);
    await deliver(JSON.stringify(result), deps, checkpoint);
    if (result.status === 'ok' && verb === 'read') checkpoint?.save((result as BusInboxPage & { status: 'ok' }).nextCursor);
    return busStatusExitCode(result.status);
  } catch (error) {
    if (!values.has('--checkpoint')) throw error;
    console.error(`bus checkpoint: ${error instanceof Error ? error.message : 'delivery or persistence failed'}`);
    return 1;
  } finally { checkpoint?.close(); }
}
