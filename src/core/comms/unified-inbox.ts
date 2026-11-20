/**
 * RQ-SWE3-COMMS-DEPTH-1: the unified comms inbox — one prioritized view over
 * every pending comms item, each carrying the deep-link command that acts on it.
 *
 *   readUnifiedInbox(opts) — aggregates six local, read-only sources:
 *
 *   needs-you   NEEDS-MASON.md ledger lines still unresolved
 *               (`phm fleet needs`), act: `phm fleet needs-resolve`.
 *   imessage    unanswered allowlisted teammate texts in teammates.jsonl
 *               (`phm fleet teammate-texts`), act: mark answered or claim the
 *               mirrored bus envelope `imessage-teammate-<rowid>`.
 *   drafts      outbound email drafts still pending approval
 *               (`phm drafts list --status pending`), act: show/approve/reject.
 *   bus         live envelopes whose body the claim contract accepts
 *               (`isClaimableWork`: a `kind:'work'` body, or a protocol-v1
 *               transport `task` body) with no live claim row — an expired
 *               lease is free again and counts as unclaimed — act:
 *               `phm fleet bus-claim acquire`. A live
 *               coordination-table row on the envelope's `queue:<id>` key
 *               (resource, lane or board claims share the one table the
 *               message-id claim consults) also counts as held. The same
 *               section also lists open agent-bus v2 work-feed jobs (queued or
 *               rescheduled `work.post` announcements with at least one claim
 *               key not fully held), read through the same projection
 *               `phm agents bus work feed` serves — act:
 *               `phm agents bus claim acquire` — and every live
 *               `worker-handoff` envelope (`isWorkerHandoffBody`, the exact
 *               contract `fleet handoff-receive`/`handoff-reply` accept), so a
 *               pending assignment surfaces here instead of only in
 *               `agents bus work mine` — act: `phm fleet handoff-receive`.
 *               When the claims table itself
 *               cannot be read the section reports 'degraded' and still lists
 *               candidates rather than hiding possibly unclaimed work; a
 *               refused or unreadable feed degrades it the same way.
 *   gmail       one item per inbox in the saved Gmail archive plan whose unread
 *               count is over its target (`phm fleet gmail-archive-plan`). A
 *               read of the saved plan only: no mail is read, moved or deleted.
 *   linkedin    unanswered LinkedIn messages saved as JSON files in the local
 *               drop folder `<runsDir>/comms/linkedin/inbox/` (see
 *               linkedin-drop.ts). Replies stay drafts (`phm drafts list
 *               --status pending`); nothing is sent from here.
 *
 * Ordering is the same deterministic contract the Needs-you surfaces use
 * (decide/needs-you.ts): severity band first, then the pure priority
 * heuristic, then expiry, then newest. Never a model call, never throws, and
 * never mutates: a degraded store reports its source state and the remaining
 * sources still list. Bus work bodies are untrusted data — titles are scrubbed
 * and single-lined, never dispatched. Deep links are command text only;
 * claiming coordinates work and grants no execution authority.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUS_FEED_OPEN_STATUSES, readBusWorkFeed, type BusWorkFeedReadResult } from '../agents/bus-work-feed-read.js';
import { coordinationRowBlocks, listCoordination } from '../agents/claim-store.js';
import { listDrafts, type Draft } from '../cos/drafts.js';
import { compareRanked, needsYouPriorityHeuristic, type AttentionItem, type NeedsYouPriority, type RankedAttentionItem } from '../decide/needs-you.js';
import { BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxOptions, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { BUS_PROTOCOL_KEY, isClaimableWork, type BusPriority } from '../fleet/bus-envelope.js';
import { isWorkerHandoffBody } from '../fleet/handoff-body.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { readNeedsMason, type NeedsMasonItem, type NeedsMasonReadResult } from '../fleet/needs-mason-resolve.js';
import { gmailArchivePlanLatestPath, readGmailArchivePlanLatest } from './gmail-archive-plan-latest.js';
import { readLinkedInDrop, type LinkedInMessage } from './linkedin-drop.js';
import { scrubSecrets } from '../util/scrub.js';
import { classifyTeammateIntent, readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';

export const UNIFIED_INBOX_MAX_ITEMS = 200;
const TITLE_MAX = 160;
const DETAIL_MAX = 300;
const SUGGESTED_LEASE_MS = 600_000;

export type UnifiedInboxSource = 'needs-you' | 'imessage' | 'drafts' | 'bus' | 'gmail' | 'linkedin';
export type UnifiedInboxSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';
export type UnifiedInboxKind = 'needs-you' | 'teammate-text' | 'draft-approval' | 'bus-work' | 'bus-handoff' | 'gmail-over-target' | 'linkedin-message';

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
  /** Trusted test seams; defaults read the real stores. */
  readNeeds?: (options: { runsDir?: string }) => NeedsMasonReadResult;
  readTexts?: typeof readTeammateTexts;
  listPendingDrafts?: typeof listDrafts;
  listBus?: typeof listBusInboxAfter;
  inspectBus?: typeof inspectBusInbox;
  readClaims?: (root?: string) => BusWorkClaimsInspection;
  readCoordination?: typeof listCoordination;
  readFeed?: typeof readBusWorkFeed;
  readGmailPlans?: typeof readGmailArchivePlanLatest;
  readLinkedIn?: typeof readLinkedInDrop;
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

/**
 * Live envelopes whose body the bus-next claim contract accepts — the work
 * loop's contract (`isClaimableWork`): a `kind:'work'` body, or a protocol-v1
 * transport `task` body. A `kind:'work'` body carrying a non-task `protocol`
 * is not claimable (the protocol branch decides), so it stays off the list.
 */
function isWorkReceipt(receipt: BusInboxReceipt): boolean {
  return isClaimableWork(receipt.envelope.body);
}

/**
 * One-line title for a bare protocol-v1 transport body — the claimable shape
 * that carries no `kind:'work'` and no `text`: `protocol <kind> <topic>:
 * <payload_ref>`, the same read the bus inbox frames compose. Typed bodies
 * (a `kind` string is present) return null so the caller keeps its
 * `work <from> → <to>` fallback; fields are read defensively because stored
 * envelopes are untrusted data.
 */
function protocolBodyTitle(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind === 'string' && kind.trim() !== '') return null;
  const proto = record[BUS_PROTOCOL_KEY];
  if (proto === null || typeof proto !== 'object' || Array.isArray(proto)) return null;
  const p = proto as Record<string, unknown>;
  const pk = p['kind'];
  if (typeof pk !== 'string' || pk.trim() === '') return null;
  const field = (key: string): string | null => {
    const value = p[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const head = ['protocol', pk.trim(), field('topic')].filter((part): part is string => part !== null).join(' ');
  const ref = field('payload_ref');
  return ref === null ? head : `${head}: ${ref}`;
}

/** Announcement metadata for a v2 work job, read off its live `work.post` receipt. */
interface BusFeedPost {
  priority: BusPriority;
  receivedAt: number;
  expiresAt: number;
}

/**
 * Open v2 work-feed jobs with claimable scope, from the same read-only
 * projection `phm agents bus work feed` serves. A job counts as pending while
 * it is queued or rescheduled, declares at least one claim key, and — when the
 * coordination table is readable — at least one of those keys has no live hold.
 * Unknown holds list candidates under 'degraded' rather than hiding them. A
 * refused, retryable or unreadable feed degrades the section; it never
 * invents jobs.
 */
function busFeedJobItems(options: UnifiedInboxOptions, now: number,
  posts: ReadonlyMap<string, BusFeedPost>): { state: 'ok' | 'degraded' | 'unavailable'; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let feed: BusWorkFeedReadResult;
  try { feed = (options.readFeed ?? readBusWorkFeed)({ root: options.busRoot, claims: true, now: () => now }); }
  catch { return { state: 'unavailable', items: [] }; }
  if (feed.status === 'unavailable') return { state: 'unavailable', items: [] };
  if (feed.status !== 'ok') return { state: 'degraded', items: [] };

  const holdsKnown = feed.claims?.source !== 'unavailable';
  const heldKeys = new Map<string, Set<string>>();
  if (feed.claims) {
    for (const hold of feed.claims.holds) {
      const set = heldKeys.get(hold.jobId) ?? new Set<string>();
      set.add(hold.claimKey);
      heldKeys.set(hold.jobId, set);
    }
  }

  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const job of feed.jobs) {
    if (!BUS_FEED_OPEN_STATUSES.has(job.status) || job.claimKeys.length === 0) continue;
    const held = heldKeys.get(job.id);
    const freeKeys = holdsKnown ? job.claimKeys.filter(key => !held?.has(key)) : job.claimKeys;
    if (freeKeys.length === 0) continue;
    const claimKey = freeKeys.find(key => key.startsWith('queue:')) ?? freeKeys[0]!;
    const post = posts.get(job.id);
    // The feed job carries the announcement's own title; the receipt scan only
    // adds priority and expiry the projection does not keep.
    const title = oneLine(job.title, TITLE_MAX);
    const heldCount = held?.size ?? 0;
    items.push({
      id: `bus-feed:${job.id}`,
      source: 'bus',
      kind: 'bus-work',
      severity: post?.priority === 'P0' ? 'high' : post?.priority === 'P1' ? 'warn' : 'info',
      blocking: false,
      title: title || `bus work ${job.id}`,
      detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
        (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`) +
        (holdsKnown ? ` · ${heldCount}/${job.claimKeys.length} claim keys held` : ' · claim holds unknown'), DETAIL_MAX),
      since: iso(post?.receivedAt ?? job.updatedAt),
      expiresAt: post ? iso(post.expiresAt) : null,
      act: [
        `phm agents bus claim acquire --key ${claimKey} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`,
        'phm agents bus work feed --claims',
      ],
    });
  }
  return { state: holdsKnown ? 'ok' : 'degraded', items };
}

function busItems(options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const bus: BusInboxOptions = { root: options.busRoot, now: options.now };
  let inspection: BusInboxInspection;
  try { inspection = (options.inspectBus ?? inspectBusInbox)(bus); }
  catch { inspection = { source: 'unavailable', retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null }; }
  if (inspection.source !== 'available') return { report: { state: inspection.source === 'missing' ? 'missing' : 'unavailable', pending: 0 }, items: [] };

  const now = (options.now ?? Date.now)();
  const claims = (options.readClaims ?? inspectBusWorkClaims)(options.busRoot);
  const coordination = (options.readCoordination ?? listCoordination)(options.busRoot, now);
  // A message-id claim lands in the same coordination table under
  // `queue:<envelope id>`, so a live row there — resource, lane or board —
  // means the canonical acquire would conflict: the work is held, not free.
  const coordinationHolds = coordination.source === 'available'
    ? coordination.claims.filter(row => row.live) : [];
  const taken = (receipt: BusInboxReceipt): boolean =>
    claims.claims.some(row =>
      row.id === receipt.envelope.id && row.cursor === receipt.cursor && row.receivedAt === receipt.receivedAt &&
      (row.completedAt !== null || row.leaseUntil > now)) ||
    coordinationHolds.some(row => coordinationRowBlocks(row, `queue:${receipt.envelope.id}`));

  const list = options.listBus ?? listBusInboxAfter;
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  const feedPosts = new Map<string, BusFeedPost>();
  let state: UnifiedInboxSourceState = claims.source === 'unavailable' || coordination.source === 'unavailable' ? 'degraded' : 'healthy';
  let after = 0;
  // Same paging bound the work loop accepts: the store retains at most
  // BUS_INBOX_MAX_MESSAGES records over BUS_INBOX_MAX_READ-sized pages.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    let result: ReturnType<typeof listBusInboxAfter>;
    try { result = list(after, BUS_INBOX_MAX_READ, bus); } catch { result = { status: 'unavailable' }; }
    if (result.status !== 'ok') { state = result.status === 'retryable' ? 'degraded' : 'unavailable'; break; }
    for (const receipt of result.messages) {
      const { envelope } = receipt;
      const body = envelope.body;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (record.kind === 'work.post' && typeof record.jobId === 'string' && !feedPosts.has(record.jobId)) {
          feedPosts.set(record.jobId, {
            priority: envelope.priority,
            receivedAt: receipt.receivedAt,
            // The reader decrements ttl to what remains; expiry is a real deadline.
            expiresAt: now + envelope.ttl,
          });
        }
      }
      // A live worker-handoff is a pending assignment, not claimable work:
      // receiving it runs `fleet handoff-receive`/`handoff-reply`, which check
      // no claims, so it lists regardless of hold state until its TTL ends.
      // The title matches the shared bus composer (`handoff task <id>: <prompt>`).
      if (isWorkerHandoffBody(envelope.body)) {
        items.push({
          id: `bus-handoff:${envelope.id}`,
          source: 'bus',
          kind: 'bus-handoff',
          severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
          blocking: false,
          title: oneLine(`handoff task ${envelope.body.taskId}: ${envelope.body.prompt}`, TITLE_MAX),
          detail: cap(`from ${envelope.from} to ${envelope.to} · ${envelope.priority} · cursor ${receipt.cursor}`, DETAIL_MAX),
          since: iso(receipt.receivedAt),
          expiresAt: iso(now + envelope.ttl),
          act: [
            `phm fleet handoff-receive --id ${envelope.id} --to ${envelope.to} --snapshot <abs-json> -- <program> [args...]`,
            `phm agents bus show ${envelope.id}`,
          ],
        });
        continue;
      }
      if (!isWorkReceipt(receipt) || taken(receipt)) continue;
      const text = body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string'
        ? body.text : '';
      items.push({
        id: `bus:${envelope.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
        blocking: false,
        // `kind:'work'` bodies title from their text; bare protocol `task`
        // bodies have no text, so their kind/topic/ref names the item.
        title: oneLine(text || protocolBodyTitle(body) || `work ${envelope.from} → ${envelope.to}`, TITLE_MAX),
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
  const feed = busFeedJobItems(options, now, feedPosts);
  items.push(...feed.items);
  if (feed.state === 'unavailable') state = 'unavailable';
  else if (feed.state === 'degraded' && state === 'healthy') state = 'degraded';
  return { report: { state, pending: items.length }, items };
}

function gmailItems(read: typeof readGmailArchivePlanLatest, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let latest: ReturnType<typeof readGmailArchivePlanLatest> = null;
  try { latest = read(dir); } catch { latest = null; }
  if (latest === null) {
    // A reader that returns null for a file that exists means unreadable or invalid, not absent.
    return { report: { state: existsSync(gmailArchivePlanLatestPath(dir)) ? 'degraded' : 'missing', pending: 0 }, items: [] };
  }
  const items = latest.plans.filter(plan => plan.unread > plan.target).map((plan): Omit<UnifiedInboxItem, 'priority'> => {
    const senders = plan.topSenders.map(s => `${s.sender} (${s.count})`).join(', ');
    return {
      id: `gmail:${plan.inbox}`,
      source: 'gmail',
      kind: 'gmail-over-target',
      severity: plan.target > 0 && plan.unread >= 2 * plan.target ? 'high' : 'warn',
      blocking: false,
      title: oneLine(`${plan.inbox}: ${plan.unread} unread, target ${plan.target}`, TITLE_MAX),
      detail: oneLine(`archive plan proposes ${plan.archiveCount}; top senders: ${senders || 'none'}`, DETAIL_MAX),
      since: plan.at,
      expiresAt: null,
      act: ['phm fleet gmail-archive-plan'],
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

function linkedInItems(read: typeof readLinkedInDrop, runsDir: string | undefined, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: ReturnType<typeof readLinkedInDrop>;
  try { result = read({ runsDir, now }); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  const items = result.messages.map((m: LinkedInMessage): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `linkedin:${m.id}`,
    source: 'linkedin',
    kind: 'linkedin-message',
    severity: 'info',
    blocking: false,
    title: oneLine(`LinkedIn from ${m.from}: ${m.text}`, TITLE_MAX),
    detail: m.threadUrl ? cap(m.threadUrl, DETAIL_MAX) : null,
    since: m.at,
    expiresAt: null,
    // Replies stay drafts until Mason confirms; nothing is sent from here.
    act: ['phm drafts list --status pending'],
  }));
  return { report: { state: result.sourceState, pending: items.length }, items };
}

/**
 * One read-only pass over every pending comms source. Never throws; a failed
 * source reports its state and the rest still list.
 */
export async function readUnifiedInbox(options: UnifiedInboxOptions = {}): Promise<UnifiedInbox> {
  const now = options.now ?? Date.now;
  const needs = needsYouItems(options.readNeeds ?? readNeedsMason, options.runsDir);
  const teammates = teammateItems(options.readTexts ?? readTeammateTexts, options.runsDir, now);
  const drafts = await draftItems(options.listPendingDrafts ?? listDrafts, options.runsDir);
  const bus = busItems(options);
  const gmail = gmailItems(options.readGmailPlans ?? readGmailArchivePlanLatest, options.runsDir);
  const linkedin = linkedInItems(options.readLinkedIn ?? readLinkedInDrop, options.runsDir, now);

  const sources: UnifiedInbox['sources'] = {
    'needs-you': needs.report,
    imessage: teammates.report,
    drafts: drafts.report,
    bus: bus.report,
    gmail: gmail.report,
    linkedin: linkedin.report,
  };
  const pending: Omit<UnifiedInboxItem, 'priority'>[] = [...needs.items, ...teammates.items, ...drafts.items, ...bus.items, ...gmail.items, ...linkedin.items];
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
