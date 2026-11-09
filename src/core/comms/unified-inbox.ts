/**
 * RQ-SWE3-COMMS-DEPTH-1: the unified comms inbox — one prioritized view over
 * every pending comms item, each carrying the deep-link command that acts on it.
 *
 *   readUnifiedInbox(opts) — aggregates four local, read-only sources:
 *
 *   needs-you   NEEDS-MASON.md ledger lines still unresolved
 *               (`phm fleet needs`), act: `phm fleet needs-resolve`.
 *   imessage    unanswered allowlisted teammate texts in teammates.jsonl
 *               (`phm fleet teammate-texts`), act: mark answered or claim the
 *               mirrored bus envelope `imessage-teammate-<rowid>`.
 *   drafts      outbound email drafts still pending approval
 *               (`phm drafts list --status pending`), act: show/approve/reject.
 *   bus         live `kind:'work'` envelopes in the local bus inbox with no
 *               live claim row — an expired lease is free again and counts as
 *               unclaimed — act: `phm fleet bus-claim acquire`. When the claims
 *               table itself cannot be read the section reports 'degraded' and
 *               still lists candidates rather than hiding possibly unclaimed
 *               work.
 *
 * Ordering is the same deterministic contract the Needs-you surfaces use
 * (decide/needs-you.ts): severity band first, then the pure priority
 * heuristic, then expiry, then newest. Never a model call, never throws, and
 * never mutates: a degraded store reports its source state and the remaining
 * sources still list. Bus work bodies are untrusted data — titles are scrubbed
 * and single-lined, never dispatched. Deep links are command text only;
 * claiming coordinates work and grants no execution authority.
 */

import { listDrafts, type Draft } from '../cos/drafts.js';
import { compareRanked, needsYouPriorityHeuristic, type AttentionItem, type NeedsYouPriority, type RankedAttentionItem } from '../decide/needs-you.js';
import { BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxOptions, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { readNeedsMason, type NeedsMasonItem, type NeedsMasonReadResult } from '../fleet/needs-mason-resolve.js';
import { scrubSecrets } from '../util/scrub.js';
import { readLinkedInPending } from './linkedin-drop.js';
import { classifyTeammateIntent, readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';

export const UNIFIED_INBOX_MAX_ITEMS = 200;
const TITLE_MAX = 160;
const DETAIL_MAX = 300;
const SUGGESTED_LEASE_MS = 600_000;

export type UnifiedInboxSource = 'needs-you' | 'imessage' | 'linkedin' | 'drafts' | 'bus';
export type UnifiedInboxSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';
export type UnifiedInboxKind = 'needs-you' | 'teammate-text' | 'outside-message' | 'draft-approval' | 'bus-work';

export interface UnifiedInboxItem extends AttentionItem {
  /** Stable, namespaced: `<source>:<ref>` (e.g. `drafts:d-0123…`). */
  readonly id: string;
  readonly source: UnifiedInboxSource;
  readonly kind: UnifiedInboxKind;
  readonly severity: 'info' | 'warn' | 'high';
  readonly priority: NeedsYouPriority;
  readonly blocking: boolean;
  readonly title: string;
  readonly detail: string | null;
  /** ISO time the item appeared; null when the store keeps none. */
  readonly since: string | null;
  /** ISO time it stops being actionable (a bus TTL); null when none. */
  readonly expiresAt: string | null;
  /** Deep-link commands that act on this item, most direct first. */
  readonly act: readonly string[];
}

export interface UnifiedInboxSourceReport {
  state: UnifiedInboxSourceState;
  /** Pending items contributed by this source (before the global cap). */
  pending: number;
}

export interface UnifiedInbox {
  v: 1;
  generatedAt: string;
  sources: Record<UnifiedInboxSource, UnifiedInboxSourceReport>;
  /** Pending items across every source, before the display cap. */
  total: number;
  /** Pending items left off `items` by UNIFIED_INBOX_MAX_ITEMS. */
  omitted: number;
  items: UnifiedInboxItem[];
}

export interface UnifiedInboxOptions {
  /** Shared runs context (`~/.ashlr-runs`): needs-you, teammate and draft stores. */
  runsDir?: string;
  /** Private bus store root (`~/.ashlr/fleet` by default). */
  busRoot?: string;
  now?: () => number;
  /** LinkedIn inbound drop folder. */
  linkedinDir?: string;
  /** Trusted test seams; defaults read the real stores. */
  readNeeds?: (options: { runsDir?: string }) => NeedsMasonReadResult;
  readTexts?: typeof readTeammateTexts;
  listPendingDrafts?: typeof listDrafts;
  listBus?: typeof listBusInboxAfter;
  inspectBus?: typeof inspectBusInbox;
  readClaims?: (root?: string) => BusWorkClaimsInspection;
}

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string, max: number): string => cap(scrubSecrets(text).replace(/\s+/g, ' ').trim(), max);
const iso = (ms: number): string => new Date(ms).toISOString();

function needsYouItems(read: NonNullable<UnifiedInboxOptions['readNeeds']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: NeedsMasonReadResult;
  try { result = read({ runsDir }); } catch { result = { status: 'unavailable', items: [] }; }
  const state: UnifiedInboxSourceState = result.status === 'available' ? 'healthy' : result.status;
  const items = result.items.map((item: NeedsMasonItem): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `needs-you:${item.id}`,
    source: 'needs-you',
    kind: 'needs-you',
    severity: 'warn',
    blocking: true,
    title: oneLine(item.text, TITLE_MAX),
    detail: null,
    since: null,
    expiresAt: null,
    act: [`phm fleet needs-resolve ${item.id} --reply "<reply>"`],
  }));
  return { report: { state, pending: items.length }, items };
}

function teammateItems(read: typeof readTeammateTexts, runsDir: string | undefined, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: ReturnType<typeof readTeammateTexts>;
  try { result = read({ runsDir, now }); } catch { result = { sourceState: 'degraded', texts: [] }; }
  const items = result.texts.map((text: TeammateText): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `imessage:teammate-${text.rowid}`,
    source: 'imessage',
    kind: 'teammate-text',
    // A finding asking for a decision or an action ranks above ordinary replies.
    severity: classifyTeammateIntent(text.text) === 'leader' ? 'warn' : 'info',
    blocking: false,
    title: oneLine(text.text, TITLE_MAX),
    detail: `${text.senderId} · waiting ${text.ageMinutes}m`,
    since: text.at,
    expiresAt: null,
    act: [`phm fleet teammate-texts --answered ${text.rowid}`,
      `phm fleet bus-claim acquire --id imessage-teammate-${text.rowid} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`],
  }));
  return { report: { state: result.sourceState, pending: items.length }, items };
}

function linkedinItems(dir: string | undefined, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: ReturnType<typeof readLinkedInPending>;
  try { result = readLinkedInPending({ dir, now }); } catch { result = { sourceState: 'degraded', messages: [], badFiles: 0 }; }
  const items = result.messages.map((message): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `linkedin:${message.id}`,
    source: 'linkedin',
    kind: 'outside-message',
    severity: 'info',
    blocking: false,
    title: oneLine(message.text, TITLE_MAX),
    detail: oneLine(`${message.from.name} · Draft only: outside contact`, DETAIL_MAX),
    since: message.receivedAt,
    expiresAt: null,
    act: [],
  }));
  return { report: { state: result.sourceState, pending: items.length }, items };
}

async function draftItems(list: typeof listDrafts, runsDir: string | undefined): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  // An absent store reads as an empty list; only a read failure is 'unavailable'.
  let drafts: Draft[] = [];
  let state: UnifiedInboxSourceState = 'healthy';
  try { drafts = await list({ runsDir, status: 'pending' }); } catch { state = 'unavailable'; }
  const items = drafts.map((draft): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `drafts:${draft.id}`,
    source: 'drafts',
    kind: 'draft-approval',
    severity: 'info',
    // The outbound send is held until the owner decides.
    blocking: true,
    title: oneLine(`Approve outbound email to ${draft.to}`, TITLE_MAX),
    detail: cap(`${draft.subject || '(no subject)'} · digest ${draft.digest.slice(0, 12)}`, DETAIL_MAX),
    since: draft.createdAt,
    expiresAt: null,
    act: [`phm drafts show ${draft.id}`, `phm drafts approve ${draft.id}`, `phm drafts reject ${draft.id}`],
  }));
  return { report: { state, pending: items.length }, items };
}

/** Live envelopes whose body marks them claimable work (the work loop's contract). */
function isWorkReceipt(receipt: BusInboxReceipt): boolean {
  const body = receipt.envelope.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) && body.kind === 'work';
}

function busItems(options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const bus: BusInboxOptions = { root: options.busRoot, now: options.now };
  let inspection: BusInboxInspection;
  try { inspection = (options.inspectBus ?? inspectBusInbox)(bus); }
  catch { inspection = { source: 'unavailable', retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null }; }
  if (inspection.source !== 'available') return { report: { state: inspection.source === 'missing' ? 'missing' : 'unavailable', pending: 0 }, items: [] };

  const now = (options.now ?? Date.now)();
  const claims = (options.readClaims ?? inspectBusWorkClaims)(options.busRoot);
  const taken = (receipt: BusInboxReceipt): boolean => claims.claims.some(row =>
    row.id === receipt.envelope.id && row.cursor === receipt.cursor && row.receivedAt === receipt.receivedAt &&
    (row.completedAt !== null || row.leaseUntil > now));

  const list = options.listBus ?? listBusInboxAfter;
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  let state: UnifiedInboxSourceState = claims.source === 'unavailable' ? 'degraded' : 'healthy';
  let after = 0;
  // Same paging bound the work loop accepts: the store retains at most
  // BUS_INBOX_MAX_MESSAGES records over BUS_INBOX_MAX_READ-sized pages.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    let result: ReturnType<typeof listBusInboxAfter>;
    try { result = list(after, BUS_INBOX_MAX_READ, bus); } catch { result = { status: 'unavailable' }; }
    if (result.status !== 'ok') { state = result.status === 'retryable' ? 'degraded' : 'unavailable'; break; }
    for (const receipt of result.messages) {
      if (!isWorkReceipt(receipt) || taken(receipt)) continue;
      const { envelope } = receipt;
      const text = envelope.body !== null && typeof envelope.body === 'object' && !Array.isArray(envelope.body) && typeof envelope.body.text === 'string'
        ? envelope.body.text : '';
      items.push({
        id: `bus:${envelope.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
        blocking: false,
        title: oneLine(text || `work ${envelope.from} → ${envelope.to}`, TITLE_MAX),
        detail: cap(`from ${envelope.from} to ${envelope.to} · ${envelope.priority} · cursor ${receipt.cursor}`, DETAIL_MAX),
        since: iso(receipt.receivedAt),
        // The reader decrements ttl to what remains; expiry is a real deadline.
        expiresAt: iso(now + envelope.ttl),
        act: [`phm fleet bus-claim acquire --id ${envelope.id} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`],
      });
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) break;
    if (result.nextCursor <= after) { state = 'degraded'; break; }
    after = result.nextCursor;
  }
  return { report: { state, pending: items.length }, items };
}

/**
 * One read-only pass over every pending comms source. Never throws; a failed
 * source reports its state and the rest still list.
 */
export async function readUnifiedInbox(options: UnifiedInboxOptions = {}): Promise<UnifiedInbox> {
  const now = options.now ?? Date.now;
  const needs = needsYouItems(options.readNeeds ?? readNeedsMason, options.runsDir);
  const teammates = teammateItems(options.readTexts ?? readTeammateTexts, options.runsDir, now);
  const linkedin = linkedinItems(options.linkedinDir, now);
  const drafts = await draftItems(options.listPendingDrafts ?? listDrafts, options.runsDir);
  const bus = busItems(options);

  const sources: UnifiedInbox['sources'] = {
    'needs-you': needs.report,
    imessage: teammates.report,
    linkedin: linkedin.report,
    drafts: drafts.report,
    bus: bus.report,
  };
  const pending: Omit<UnifiedInboxItem, 'priority'>[] = [...needs.items, ...teammates.items, ...linkedin.items, ...drafts.items, ...bus.items];
  const nowMs = now();
  const ranked: RankedAttentionItem<UnifiedInboxItem>[] = pending.map((partial) => {
    const item: UnifiedInboxItem = { ...partial, priority: needsYouPriorityHeuristic(partial, nowMs) };
    return { item, priority: item.priority, path: 'fallback', confidence: 1 };
  });
  ranked.sort(compareRanked);
  const total = ranked.length;
  return {
    v: 1,
    generatedAt: iso(nowMs),
    sources,
    total,
    omitted: Math.max(0, total - UNIFIED_INBOX_MAX_ITEMS),
    items: ranked.slice(0, UNIFIED_INBOX_MAX_ITEMS).map(({ item }) => item),
  };
}
