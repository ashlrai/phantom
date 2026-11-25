import { isProxy } from 'node:util/types';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
import { annotateLiveEvidence, type BusEnvelopeLookupJob } from '../agents/bus-unified.js';
import { readAgentRegistry, resolveAgent } from '../agents/bus-identity.js';

/** Select data correlations only; routing labels and message bodies confer no authority. */
export function projectBusThread(rows: readonly BusInboxReceipt[], id: string): BusInboxReceipt[] {
  if (!rows.some(row => row.envelope.id === id)) return [];
  const children = new Map<string, BusInboxReceipt[]>();
  for (const row of rows) {
    const body = row.envelope.body;
    if (!body || typeof body !== 'object' || isProxy(body) || Array.isArray(body)) continue;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) continue;
    const property = Object.getOwnPropertyDescriptor(body, 'inReplyTo');
    if (!property?.enumerable || !('value' in property) || typeof property.value !== 'string') continue;
    const list = children.get(property.value) ?? [];
    list.push(row);
    children.set(property.value, list);
  }
  const selected = new Set([id]), pending = [id];
  for (let i = 0; i < pending.length; i++) {
    for (const row of children.get(pending[i]!) ?? []) {
      if (!selected.has(row.envelope.id)) {
        selected.add(row.envelope.id);
        pending.push(row.envelope.id);
      }
    }
  }
  const emitted = new Set<string>();
  return [...rows].sort((a, b) => a.cursor - b.cursor).filter(row => {
    const key = row.envelope.id;
    if (!selected.has(key) || emitted.has(key)) return false;
    emitted.add(key);
    return true;
  });
}

/**
 * One retained thread receipt plus, when the read asked for live evidence,
 * the same per-message annotations `agents bus inbox`, `agents bus channel
 * read` and `agents bus show` report: `held`/`holder` on claimable work and
 * worker-handoff bodies — whether a taken message-id claim or a live
 * coordination hold provably covers the exact receipt, `held` false proof of
 * free and null a hold store that could not be read — `job` on bodies that
 * name a job (the live feed state of the cited job, or the feed's own
 * refusal/unavailable state), and `fromAgent`, the registered handle of the
 * sender label or null — a label is never authentication. Every field stays
 * absent on a raw read and on a body kind the annotation does not cover —
 * never guessed.
 */
export interface BusThreadMessage extends BusInboxReceipt {
  held?: boolean | null;
  holder?: string | null;
  job?: BusEnvelopeLookupJob;
  fromAgent?: string | null;
}

export interface BusThreadOptions extends BusInboxOptions {
  /**
   * Annotate each thread message with the live evidence `agents bus inbox`,
   * `agents bus channel read` and `agents bus show` report — `held`/`holder`
   * on claimable work and worker-handoff bodies, `job` on job-citing bodies,
   * `fromAgent` on every row — through the same shared annotation those
   * reads apply, so a thread answers "is this work already claimed" and
   * "where does the cited job stand" without a `show` per message. Off by
   * default: callers that only need the retained envelopes (the worker-run
   * prompt section) never pay for the hold-store, feed and registry reads
   * the evidence costs. Read-only either way — the annotation reads the
   * same stores the unified reads do and writes nothing.
   */
  liveEvidence?: boolean;
}

export interface BusThreadResult {
  schema: 'fleet.bus-thread.v1';
  requestedId: string;
  rootFound: boolean;
  messages: BusThreadMessage[];
  scannedThrough: number;
  complete: boolean;
  sourceFailure: string | null;
}

/**
 * The sender-handle decoration `bus show`, `agents bus inbox` and
 * `channel read` apply to every row: the registered handle of the
 * envelope's `from` label, or null — an unreadable registry or an
 * unresolvable label stays null, never a guessed name.
 */
function annotateThreadSenders(messages: BusThreadMessage[], options: BusInboxOptions): void {
  const read = readAgentRegistry(options);
  const registry = read.status === 'ok' ? read.registry : undefined;
  for (const message of messages) {
    message.fromAgent = registry === undefined ? null
      : resolveAgent(registry, message.envelope.from)?.handle ?? null;
  }
}

/** Read bounded live pages and recheck TTL before projection. Pages are not an atomic snapshot. */
export function readBusThread(id: string, options: BusThreadOptions = {}, list = listBusInboxAfter): BusThreadResult {
  const { liveEvidence = false, ...busOptions } = options;
  const rows: BusInboxReceipt[] = [];
  let cursor = 0, complete = false, failure: string | null = null;
  let now = 0, clockValid = false;
  try {
    now = (busOptions.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('clock');
    clockValid = true;
    while (cursor < BUS_INBOX_MAX_MESSAGES) {
      const page = list(cursor, BUS_INBOX_MAX_READ, { ...busOptions, now: () => now });
      if (page.status !== 'ok') { failure = page.status; break; }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || page.nextCursor > BUS_INBOX_MAX_MESSAGES ||
        page.messages.length > BUS_INBOX_MAX_READ || page.messages.some((row, i) =>
          !Number.isSafeInteger(row.cursor) || row.cursor <= (i ? page.messages[i - 1]!.cursor : cursor) || row.cursor > page.nextCursor)) {
        failure = 'invalid-page'; break;
      }
      if (page.nextCursor === cursor && page.messages.length !== 0) { failure = 'invalid-page'; break; }
      rows.push(...page.messages);
      const advanced = page.nextCursor > cursor;
      cursor = page.nextCursor;
      if (page.messages.length < BUS_INBOX_MAX_READ || cursor === BUS_INBOX_MAX_MESSAGES) { complete = true; break; }
      if (!advanced) { failure = 'invalid-page'; break; }
    }
  } catch { failure = 'unavailable'; }
  let live: BusInboxReceipt[] = [];
  try {
    if (!clockValid) throw new Error('clock');
    const finishedAt = (busOptions.now ?? Date.now)();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) throw new Error('clock');
    const elapsed = Math.max(0, finishedAt - now);
    live = rows.filter(row => row.envelope.ttl > elapsed).map(row => ({
      ...row, envelope: { ...row.envelope, ttl: row.envelope.ttl - elapsed },
    }));
  } catch { complete = false; failure = 'clock'; }
  const messages: BusThreadMessage[] = projectBusThread(live, id);
  // The evidence reads run against the same frozen instant the TTL recheck
  // used, so lease liveness and feed state describe the read's own snapshot.
  if (liveEvidence && messages.length > 0) {
    annotateLiveEvidence(messages, { ...busOptions, now: () => now });
    annotateThreadSenders(messages, busOptions);
  }
  return { schema: 'fleet.bus-thread.v1', requestedId: id, rootFound: messages.length > 0,
    messages, scannedThrough: cursor, complete, sourceFailure: failure };
}
