/**
 * Read side of resolveNeedsMason: page the durable bus inbox for the one live
 * `needs_mason.resolved` envelope owned by an item id and return Mason's reply
 * as scrubbed data. Read-only: the reply is untrusted text to display or relay,
 * never an instruction to execute, and the store is never mutated. TTL and the
 * private-path checks stay with listBusInboxAfter, so expired or unreadable
 * stores can only produce unknown/unavailable, never stale data.
 */
import {
  BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter,
  type BusInboxOptions, type BusInboxPage,
} from './bus-inbox.js';
import { NEEDS_MASON_REPLY_MAX, NEEDS_MASON_RESOLVED_KIND } from './needs-mason-resolve.js';
import { scrubSecrets } from '../util/scrub.js';

export const NEEDS_MASON_ANSWER_ID = /^nm-[0-9a-f]{12}$/;
const ITEM_TEXT_MAX = 300; // needs-mason-resolve.ts TEXT_MAX
const SOURCE_MAX = 32; // 'desktop' | 'telegram' | 'cli' | 'phone' | 'email'
const RESOLVED_AT_MAX = 64; // ISO-8601 text

export interface NeedsMasonAnswer {
  itemId: string;
  /** Scrubbed ledger text Mason answered. */
  item: string;
  /** Scrubbed reply text, or null when the item was resolved without one. */
  reply: string | null;
  /** Scrubbed surface label recorded at resolution time. */
  source: string;
  resolvedAt: string;
}

export type NeedsMasonAnswerResult =
  | { status: 'found'; id: string; cursor: number; receivedAt: number; answer: NeedsMasonAnswer }
  | { status: 'invalid' | 'unknown' | 'unavailable' };

export interface NeedsMasonAnswerDeps { list?: typeof listBusInboxAfter }

/** Only a writer-shaped body counts; anything else is unrelated traffic. */
function answerFields(body: unknown, itemId: string): Omit<NeedsMasonAnswer, 'itemId'> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const { kind, item, reply, source, resolvedAt } = record;
  if (kind !== NEEDS_MASON_RESOLVED_KIND || record.itemId !== itemId ||
      typeof item !== 'string' || !item.length || item.length > ITEM_TEXT_MAX ||
      (reply !== undefined && (typeof reply !== 'string' || !reply.length || reply.length > NEEDS_MASON_REPLY_MAX)) ||
      typeof source !== 'string' || !source.length || source.length > SOURCE_MAX ||
      typeof resolvedAt !== 'string' || !resolvedAt.length || resolvedAt.length > RESOLVED_AT_MAX ||
      Number.isNaN(Date.parse(resolvedAt))) return null;
  return {
    item: scrubSecrets(item),
    reply: typeof reply === 'string' ? scrubSecrets(reply) : null,
    source: scrubSecrets(source),
    resolvedAt: scrubSecrets(resolvedAt),
  };
}

/**
 * Scan every retained live receipt (bounded by the store's own 1024-message
 * window) for the envelope `needs-mason-resolved-<id>` routed mason -> leaders.
 * The deterministic id is claimed by resolveNeedsMason, so a malformed body
 * under it — or a well-formed body under any other id — is ignored rather
 * than reported; no retained live match is always 'unknown', never a guess.
 */
export function readNeedsMasonAnswer(itemId: unknown, options: BusInboxOptions = {},
    deps: NeedsMasonAnswerDeps = {}): NeedsMasonAnswerResult {
  if (typeof itemId !== 'string' || !NEEDS_MASON_ANSWER_ID.test(itemId)) return { status: 'invalid' };
  const wanted = `needs-mason-resolved-${itemId}`;
  const list = deps.list ?? listBusInboxAfter;
  let cursor = 0, scanned = 0;
  // One extra page covers a full page ending exactly at the high-water mark.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    let result: BusInboxPage;
    try { result = list(cursor, BUS_INBOX_MAX_READ, options); }
    catch { return { status: 'unavailable' }; }
    if (result.status !== 'ok') return { status: 'unavailable' };
    scanned += result.messages.length;
    if (scanned > BUS_INBOX_MAX_MESSAGES || result.messages.length > BUS_INBOX_MAX_READ ||
        !Number.isSafeInteger(result.nextCursor) || result.nextCursor < cursor ||
        result.messages.some((row, index) => !Number.isSafeInteger(row.cursor) ||
          row.cursor <= (index ? result.messages[index - 1]!.cursor : cursor) ||
          row.cursor > result.nextCursor || !Number.isSafeInteger(row.receivedAt) || row.receivedAt < 0)) {
      return { status: 'unavailable' };
    }
    for (const receipt of result.messages) {
      const { envelope } = receipt;
      if (envelope.id !== wanted || envelope.from !== 'mason' || envelope.to !== 'leaders') continue;
      const answer = answerFields(envelope.body, itemId);
      if (answer) return { status: 'found', id: envelope.id, cursor: receipt.cursor, receivedAt: receipt.receivedAt, answer: { itemId, ...answer } };
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) return { status: 'unknown' };
    if (result.nextCursor === cursor) return { status: 'unavailable' };
    cursor = result.nextCursor;
  }
  return { status: 'unknown' };
}
