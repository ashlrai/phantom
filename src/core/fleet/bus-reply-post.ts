import { validateBusEnvelope } from './bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';

export interface ReplyDependencies {
  list?: typeof listBusInboxAfter;
  append?: typeof appendBusInbox;
}
export type ReplyOutcome = 'posted' | 'duplicate' | 'request-not-found' | 'invalid-input' | 'transport-refused';
export interface ReplyResult {
  schema: 'fleet.bus-reply.v1';
  correlation: 'untrusted-routing-only';
  outcome: ReplyOutcome;
  transport: string | null;
}
export function replyResult(outcome: ReplyOutcome, transport: string | null = null): ReplyResult {
  return { schema: 'fleet.bus-reply.v1', correlation: 'untrusted-routing-only', outcome, transport };
}

/** Routing/correlation confer neither responder authentication nor work completion. */
export function postBusReply(requestId: string, replyId: string, body: unknown,
  options: BusInboxOptions = {}, deps: ReplyDependencies = {}): ReplyResult {
  // Validate data before inspecting properties or spreading caller input.
  const input = validateBusEnvelope({ id: replyId, from: requestId, to: requestId, priority: 'P2', ttl: 1, body });
  if (!input.ok || replyId === requestId || input.value.body === null || typeof input.value.body !== 'object' ||
      Array.isArray(input.value.body) || Object.hasOwn(input.value.body, 'inReplyTo')) return replyResult('invalid-input');
  try {
    const clock = options.now ?? Date.now, started = clock();
    if (!Number.isSafeInteger(started) || started < 0) return replyResult('transport-refused');
    let cursor = 0, count = 0;
    let request: BusInboxReceipt | undefined, prior: BusInboxReceipt | undefined;
    // Cursor high-water marks can exceed the retained-message limit after pruning.
    for (let pages = 0; pages <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); pages++) {
      const page = (deps.list ?? listBusInboxAfter)(cursor, BUS_INBOX_MAX_READ, { ...options, now: () => started });
      if (page.status !== 'ok') return replyResult('transport-refused', page.status);
      count += page.messages.length;
      if (count > BUS_INBOX_MAX_MESSAGES || page.messages.length > BUS_INBOX_MAX_READ ||
          !Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor ||
          page.messages.some((row, i) => !Number.isSafeInteger(row.cursor) ||
            row.cursor <= (i ? page.messages[i - 1]!.cursor : cursor) || row.cursor > page.nextCursor)) return replyResult('transport-refused');
      for (const row of page.messages) {
        if (row.envelope.id === requestId) request = row;
        if (row.envelope.id === replyId) prior = row;
      }
      if (page.messages.length < BUS_INBOX_MAX_READ) break;
      if (page.nextCursor === cursor) return replyResult('transport-refused');
      cursor = page.nextCursor;
    }
    const finished = clock();
    if (!Number.isSafeInteger(finished) || finished < started) return replyResult('transport-refused');
    if (!request || request.envelope.ttl <= finished - started) return replyResult('request-not-found');
    const remaining = request.envelope.ttl - (finished - started);
    // Reconstruct retained wire TTL for exact retry comparison. append owns dedupe;
    // a duplicate cannot refresh its receipt timestamp or lifetime.
    const ttl = prior ? prior.envelope.ttl + Math.max(0, started - prior.receivedAt) : remaining;
    const checked = validateBusEnvelope({ id: replyId, from: request.envelope.to, to: request.envelope.from,
      priority: request.envelope.priority, ttl, body: { ...input.value.body, inReplyTo: requestId } });
    if (!checked.ok) return replyResult('invalid-input');
    const receipt = (deps.append ?? appendBusInbox)(checked.value, { ...options, now: () => finished });
    return receipt.status === 'posted' || receipt.status === 'duplicate'
      ? replyResult(receipt.status, receipt.status) : replyResult('transport-refused', receipt.status);
  } catch { return replyResult('transport-refused'); }
}
