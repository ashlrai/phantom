import { performance } from 'node:perf_hooks';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, appendBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxPost, type BusInboxReceipt } from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';

export type RequestOutcome = 'replied' | 'timeout' | 'cancelled' | 'post-refused' | 'source-unavailable' | 'invalid-input';
export interface RequestResult {
  schema: 'fleet.bus-request.v1';
  receipt: BusInboxPost | { status: 'not-attempted' };
  correlation: 'untrusted-routing-only';
  outcome: RequestOutcome;
  reply: BusInboxReceipt | null;
  cursor: number;
  elapsedMs: number;
}
export interface RequestDependencies {
  list?: typeof listBusInboxAfter;
  append?: typeof appendBusInbox;
  signal?: AbortSignal;
  startedAt?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A correlation is untrusted data: routing labels authenticate neither peer nor completion. */
export async function requestBusRoundtrip(input: unknown, timeoutMs: number, intervalMs: number,
  options: BusInboxOptions = {}, deps: RequestDependencies = {}): Promise<RequestResult> {
  const start = deps.startedAt ?? performance.now();
  let receipt: RequestResult['receipt'] = { status: 'not-attempted' }, cursor = 0;
  const result = (outcome: RequestOutcome, reply: BusInboxReceipt | null = null): RequestResult => ({
    schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only', receipt, outcome, reply, cursor, elapsedMs: Math.max(0, Math.floor(performance.now() - start)),
  });
  const checked = validateBusEnvelope(input);
  if (!checked.ok || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) return result('invalid-input');
  const request: BusEnvelope = checked.value;
  const deadline = start + Math.min(timeoutMs, request.ttl);
  const stopped = (): RequestOutcome | null => deps.signal?.aborted ? 'cancelled' : performance.now() >= deadline ? 'timeout' : null;
  const pause = async (): Promise<void> => wait(Math.max(0, Math.min(intervalMs, deadline - performance.now())), deps.signal);
  const list = deps.list ?? listBusInboxAfter;
  let beforePost = true;
  try {
    for (;;) {
      const stop = stopped();
      if (stop) return result(stop);
      const readStarted = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(readStarted) || readStarted < 0) return result('source-unavailable');
      const page = list(cursor, BUS_INBOX_MAX_READ, options);
      const readEnded = (options.now ?? Date.now)();
      const stopAfterRead = stopped();
      if (stopAfterRead) return result(stopAfterRead);
      if (!Number.isSafeInteger(readEnded) || readEnded < 0) return result('source-unavailable');
      if (page.status === 'retryable') { await pause(); continue; }
      if (page.status !== 'ok' || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor ||
          page.nextCursor > BUS_INBOX_MAX_MESSAGES || page.messages.length > BUS_INBOX_MAX_READ ||
          page.messages.some((row, i) => !Number.isSafeInteger(row.cursor) ||
            row.cursor <= (i ? page.messages[i - 1]!.cursor : cursor) || row.cursor > page.nextCursor)) return result('source-unavailable');
      if (stopped()) return result(stopped()!);
      if (!beforePost) {
        for (const row of page.messages) {
          const { envelope } = row, body = envelope.body;
          if (envelope.ttl > Math.max(0, readEnded - readStarted) && envelope.from === request.to && envelope.to === request.from && body !== null &&
              typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'inReplyTo') && body.inReplyTo === request.id) {
            const stopBeforeReply = stopped();
            if (stopBeforeReply) return result(stopBeforeReply);
            cursor = row.cursor;
            return result('replied', { ...row, envelope: { ...envelope, ttl: envelope.ttl - Math.max(0, readEnded - readStarted) } });
          }
        }
      }
      const advanced = page.nextCursor > cursor;
      cursor = page.nextCursor;
      if (beforePost && (page.messages.length < BUS_INBOX_MAX_READ || cursor === BUS_INBOX_MAX_MESSAGES)) {
        const stopBeforePost = stopped();
        if (stopBeforePost) return result(stopBeforePost);
        receipt = (deps.append ?? appendBusInbox)(request, options);
        const stopAfterPost = stopped();
        if (stopAfterPost) return result(stopAfterPost);
        if (receipt.status !== 'posted' && receipt.status !== 'duplicate') return result('post-refused');
        if (receipt.status === 'duplicate') cursor = 0;
        beforePost = false;
        continue;
      }
      if (!advanced || page.messages.length < BUS_INBOX_MAX_READ) await pause();
    }
  } catch { return result(stopped() ?? 'source-unavailable'); }
}
