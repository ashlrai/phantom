/**
 * RQ-SWE3-COMMS-DEPTH-1: the unified comms inbox — one prioritized view over
 * every pending comms item, each carrying the deep-link command that acts on it.
 *
 *   readUnifiedInbox(opts) — aggregates fourteen local, read-only sources:
 *
 *   needs-you   NEEDS-MASON.md ledger lines still unresolved
 *               (`phm fleet needs`), act: `phm fleet needs-resolve`.
 *   imessage    unanswered allowlisted teammate texts in teammates.jsonl
 *               (`phm fleet teammate-texts`), act: mark answered or claim the
 *               mirrored bus envelope `imessage-teammate-<rowid>`.
 *   owner-thread  live inbound owner-thread messages no recorded outbound
 *               reply cites (`phm comms thread`), the same awaiting-reply mark
 *               `comms status` counts, act: `phm comms send-owner --reply-to`.
 *   owner-delivery  recorded owner-thread replies whose fanout is not fully
 *               delivered — the delivery side of the awaiting-reply mark,
 *               which counts a reply answered even when every channel
 *               refused it (`readOwnerUndeliveredReplies`, the same read
 *               `comms status` counts as `undeliveredReplies`). A destination
 *               the thread's sent-mark or the latest receipt cannot confirm
 *               lists as failed, pending or unknown — never delivered — and
 *               resending the same text under the reply's own key and the
 *               answered inbound's key (`--reply-to`, `--idempotency-key`)
 *               retries only the unconfirmed destinations. Act:
 *               `phm comms thread`, `phm comms send-owner --reply-to`.
 *   drafts      outbound email drafts still pending approval
 *               (`phm drafts list --status pending`), act: show/approve/reject —
 *               plus pending Comms-agent reply drafts that have no cos mirror
 *               (every non-email transport, or an email mirror that failed to
 *               write; a mirrored copy already lists through the cos draft, so
 *               one pending reply is one item), act: `phm comms-agent drafts`.
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
 *               key not fully held), jobs the feed shows `blocked` or
 *               `failed`, jobs that declare no claim keys at all, and
 *               `running`/`idle` announcements whose declared keys provably
 *               lost every live hold — stalled work only the announcer can
 *               move — read
 *               through the same projection `phm agents bus work feed` serves —
 *               act: `phm agents bus claim acquire` — and every live
 *               `worker-handoff` envelope (`isWorkerHandoffBody`, the exact
 *               contract `fleet handoff-receive`/`handoff-reply` accept), so a
 *               pending assignment surfaces here instead of only in
 *               `agents bus work mine` — act: `phm fleet handoff-receive`.
 *               When the claims table itself
 *               cannot be read the section reports 'degraded' and still lists
 *               candidates rather than hiding possibly unclaimed work; a
 *               refused or unreadable feed degrades it the same way.
 *   conversations  agent-to-agent conversation threads still needing a
 *               person — the same `state:'waiting'` and `state:'blocked'`
 *               threads the one shared conversations projection computes,
 *               fleet-wide: a waiting thread names who must answer and how
 *               long it has waited, a blocked thread names who reported the
 *               block, who was told and how long it has stood. A thread
 *               whose latest message is already a pending bus item (an
 *               unclaimed work envelope or a live worker-handoff) or whose
 *               `job:` thread the feed already lists stays under the bus
 *               source: one pending thing, one item. Act: `phm agents
 *               conversations`, `phm agents bus show`, `phm agents bus
 *               post --thread`.
 *   seats       bot seats whose projected handoff plan still has work to
 *               move — the same `planSeatHandoffs` read `phm bots handoffs`
 *               serves, so the inbox and that surface can never disagree.
 *               Only eligible seats (draining, or idle while still holding
 *               work or handoff history) with pending — not yet journaled —
 *               handoff records list: a draining seat with nothing left to
 *               release is already on its way to idle, not pending work.
 *               Seat handoffs are agent work, never Mason-blocking, so items
 *               are warn and non-blocking; `since` stays null because the
 *               plan's record timestamps are the read instant, not a real
 *               age. An empty roster is 'missing' (no seats configured); an
 *               unreadable roster, coordination table, node store or quota
 *               read is 'unavailable', never an empty plan passed off as
 *               fact. Act: `phm bots handoff --seat`, `phm bots handoffs`.
 *   gmail       one item per inbox in the saved Gmail archive plan whose unread
 *               count is over its target (`phm fleet gmail-archive-plan`). A
 *               read of the saved plan only: no mail is read, moved or deleted.
 *   linkedin    unanswered LinkedIn messages saved as JSON files in the local
 *               drop folder `<runsDir>/comms/linkedin/inbox/` (see
 *               linkedin-drop.ts). Replies stay drafts (`phm drafts list
 *               --status pending`); nothing is sent from here.
 *   requests    live comms questions and approvals from the request queue
 *               (`~/.ashlr/comms/requests.jsonl`, the same store `phm comms
 *               status` counts): a sent one is the single outstanding slot
 *               Mason's numbered reply or button tap resolves, a pending
 *               one is queued behind it. Informational reports never await
 *               a reply and never list. `expiresAt` is the real TTL deadline
 *               `expireStaleRequests` applies — never invented.
 *   email-outbox  `.reply.eml` artifacts the email send pass marked `stuck`
 *               in the reply outbox (`<runsDir>/queue/email-drop.json` →
 *               `outboxDir`, else the sibling of `inboxDir`) — interrupted
 *               send claims, oversized or unreadable files, malformed
 *               drafted rows. A stuck reply is a recorded delivery failure
 *               the owner is waiting on, so each lists as warn with the
 *               fixed reason and a `phm fleet email-outbox` deep link; a
 *               stuck artifact is never auto-resent. Entries carry no
 *               timestamp, so `since`/`expiresAt` stay null. Missing or
 *               invalid config, a missing outbox and an unreadable one keep
 *               their own source state — never an empty outbox passed off
 *               as fact.
 *   team-approvals  pending team approvals — access requests and
 *               consequential handoffs only an owner/admin can decide — from
 *               the team event log, the same `readTeamApprovals` section
 *               `phm approvals` and the desktop Approvals panel project,
 *               scoped to DEFAULT_TEAM like the bare command. The requested
 *               action is held until `phm team approve|deny` records the
 *               decision, so each lists as a blocking warn; the projection
 *               carries no timestamp, so `since`/`expiresAt` stay null. A
 *               throwing or refused read reports 'unavailable', never an
 *               empty approvals list passed off as fact.
 *   proposals  pending inbox proposals (`~/.ashlr/inbox`), the same
 *               `readPendingProposals` section — proposed outward actions
 *               that never auto-apply and wait on review. Info items
 *               deep-link `phm inbox show|approve|reject`; a partial capture
 *               can be rejected but never approved, so its acts drop
 *               `approve`. A truncated or incomplete read reports 'degraded'
 *               with the items it did find — never an empty list passed off
 *               as fact.
 *
 * Ordering is the same deterministic contract the Needs-you surfaces use
 * (decide/needs-you.ts): severity band first, then the pure priority
 * heuristic, then expiry, then newest. Never a model call, never throws, and
 * never mutates: a degraded store reports its source state and the remaining
 * sources still list. Bus work bodies are untrusted data — titles are scrubbed
 * and single-lined, never dispatched. Deep links are command text only;
 * claiming coordinates work and grants no execution authority.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUS_FEED_OPEN_STATUSES, readBusWorkFeed, type BusWorkFeedReadResult } from '../agents/bus-work-feed-read.js';
import { coordinationRowBlocks, listCoordination } from '../agents/claim-store.js';
import { readPendingProposals, readTeamApprovals, type ProposalApprovalItem, type TeamApprovalItem } from '../approvals/surface.js';
import { listDrafts, type Draft } from '../cos/drafts.js';
import { listDrafts as listCommsAgentDrafts, type CommsDraft } from '../comms-agent/store.js';
import { compareRanked, needsYouPriorityHeuristic, type AttentionItem, type NeedsYouPriority, type RankedAttentionItem } from '../decide/needs-you.js';
import { BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxOptions, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { BUS_PROTOCOL_KEY, isClaimableWork, type BusPriority } from '../fleet/bus-envelope.js';
import { isWorkerHandoffBody } from '../fleet/handoff-body.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { readNeedsMason, type NeedsMasonItem, type NeedsMasonReadResult } from '../fleet/needs-mason-resolve.js';
import { loadConfigReadOnly } from '../config.js';
import { readEmailDropConfig } from './email-drop-config.js';
import { probeOutboxDir, readEmailOutbox, type EmailOutboxEntry, type EmailOutboxListing } from './email-outbox.js';
import { gmailArchivePlanLatestPath, readGmailArchivePlanLatest } from './gmail-archive-plan-latest.js';
import { readLinkedInDrop, type LinkedInMessage } from './linkedin-drop.js';
import { readOwnerAwaitingReplies, readOwnerUndeliveredReplies, type OwnerAwaitingReplies, type OwnerUndeliveredReplies } from './owner-thread.js';
import { commsRequestAgeStartMs, commsRequestTtlMs, DEFAULT_REQUEST_TTL_HOURS, readCommsRequests, type CommsRequestsRead } from './requests.js';
import { readAgentConversations, plainAge, type AgentConversations } from '../fleet/agent-conversations.js';
import { JOB_THREAD_PREFIX } from '../fleet/agent-messages.js';
import { planSeatHandoffs, type SeatHandoffsPlan } from '../bots/seats.js';
import { DEFAULT_TEAM } from '../teams/tools.js';
import { scrubSecrets } from '../util/scrub.js';
import { classifyTeammateIntent, readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';

export const UNIFIED_INBOX_MAX_ITEMS = 200;
const TITLE_MAX = 160;
const DETAIL_MAX = 300;
const SUGGESTED_LEASE_MS = 600_000;

export type UnifiedInboxSource = 'needs-you' | 'imessage' | 'owner-thread' | 'owner-delivery' | 'drafts' | 'bus' | 'conversations' | 'seats' | 'gmail' | 'linkedin' | 'requests' | 'email-outbox' | 'team-approvals' | 'proposals';
export type UnifiedInboxSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';
export type UnifiedInboxKind = 'needs-you' | 'teammate-text' | 'owner-message' | 'owner-reply-undelivered' | 'draft-approval' | 'bus-work' | 'bus-handoff' | 'agent-thread' | 'seat-handoff' | 'gmail-over-target' | 'linkedin-message' | 'comms-request' | 'email-stuck' | 'team-approval' | 'inbox-proposal';

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

/** One reply artifact as the email-outbox source reports it: name, state and the fixed stuck reason — never a recipient, subject, body or path. */
export type EmailOutboxSourceEntry = Pick<EmailOutboxEntry, 'name' | 'state' | 'reason'>;

/** The resolved email-outbox read: a unified source state plus every artifact row, stuck included. */
export interface EmailOutboxSourceRead {
  state: UnifiedInboxSourceState;
  entries: readonly EmailOutboxSourceEntry[];
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
  /** Comms-agent draft store seam; default reads `<runsDir>/comms-agent/drafts.jsonl`. */
  listCommsDrafts?: (runsDir: string) => Promise<CommsDraft[]>;
  listBus?: typeof listBusInboxAfter;
  inspectBus?: typeof inspectBusInbox;
  readClaims?: (root?: string) => BusWorkClaimsInspection;
  readCoordination?: typeof listCoordination;
  readFeed?: typeof readBusWorkFeed;
  readGmailPlans?: typeof readGmailArchivePlanLatest;
  readLinkedIn?: typeof readLinkedInDrop;
  readOwnerAwaiting?: (options: { runsDir: string }) => OwnerAwaitingReplies;
  /** Undelivered-reply seam; default reads the same owner thread plus its delivery receipts. */
  readOwnerUndelivered?: (options: { runsDir: string }) => OwnerUndeliveredReplies;
  readConversations?: typeof readAgentConversations;
  readSeatHandoffs?: typeof planSeatHandoffs;
  readRequests?: typeof readCommsRequests;
  /** Test seam: the request TTL `expiresAt` uses; default resolves cfg.comms.requestTtlHours like dispatch. */
  requestTtlMs?: number;
  readEmailOutbox?: (options: { runsDir?: string }) => Promise<EmailOutboxSourceRead>;
  /** Team-approvals seam; default reads the DEFAULT_TEAM event log like `phm approvals`. */
  readTeamApprovals?: typeof readTeamApprovals;
  /** Pending-proposals seam; default reads the inbox store like `phm approvals`. */
  readInboxProposals?: typeof readPendingProposals;
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

/**
 * Live inbound owner-thread messages no recorded outbound reply cites — the
 * same awaiting-reply mark `readOwnerThread`/`readOwnerCommsStatus` report,
 * here as items. The owner is waiting on the leader, so each lists as a warn
 * with the thread read and a `send-owner --reply-to` deep link keyed by the
 * inbound's idempotency key. An unreadable thread reports 'unavailable'; it
 * never passes an empty list off as fact.
 */
function ownerThreadItems(read: NonNullable<UnifiedInboxOptions['readOwnerAwaiting']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: OwnerAwaitingReplies;
  try { result = read({ runsDir: dir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') return { report: { state: 'unavailable', pending: 0 }, items: [] };
  const items = result.items.map((reply): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `owner-thread:${reply.id}`,
    source: 'owner-thread',
    kind: 'owner-message',
    severity: 'warn',
    blocking: false,
    title: oneLine(reply.text, TITLE_MAX) || `owner message ${reply.id}`,
    detail: cap(`via ${reply.channel} · awaiting recorded reply`, DETAIL_MAX),
    since: reply.at,
    expiresAt: null,
    act: ['phm comms thread', `phm comms send-owner --text "<reply>" --reply-to ${reply.idempotencyKey}`],
  }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

/** Same shape guard `send-owner --reply-to` applies to inbound idempotency keys before one reaches a command line. */
const OWNER_REPLY_KEY = /^[A-Za-z0-9._:-]{8,80}$/;

/**
 * Recorded owner-thread replies whose fanout is not fully delivered — the
 * delivery side of the awaiting-reply mark, which counts an inbound answered
 * once a reply is recorded even when every channel refused it. Each lists as
 * a warn with the per-destination states the receipt journal proves —
 * failed, pending or unknown, never delivered — the scrubbed failure reason
 * when one was recorded, and a `phm comms thread` / `send-owner --reply-to`
 * deep link: resending the same text under the reply's own idempotency key
 * and the answered inbound's key reproduces the reply identity in every case
 * — an explicit key or a derived `reply-<digest>` one — and retries only the
 * unconfirmed destinations. An unreadable thread reports 'unavailable'; it
 * never passes an empty list off as fact. `since` is the reply's recorded
 * time — the receipt journal keeps no attempt timestamp, so a later retry's
 * age stays unknown; `expiresAt` stays null.
 */
function ownerDeliveryItems(read: NonNullable<UnifiedInboxOptions['readOwnerUndelivered']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: OwnerUndeliveredReplies;
  try { result = read({ runsDir: dir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') return { report: { state: 'unavailable', pending: 0 }, items: [] };
  const items = result.items.map((reply): Omit<UnifiedInboxItem, 'priority'> => {
    const act = ['phm comms thread'];
    // The resend must reuse the recorded text, the reply's own key and the
    // answered inbound's key or the reply identity refuses or forks; keys
    // that fail the send-owner shape guard keep the inspect link rather than
    // a command that cannot run.
    if (OWNER_REPLY_KEY.test(reply.replyTo) && OWNER_REPLY_KEY.test(reply.idempotencyKey)) {
      act.push(`phm comms send-owner --reply-to ${reply.replyTo} --idempotency-key ${reply.idempotencyKey} --text "<same reply text>"`);
    }
    return {
      id: `owner-delivery:${reply.id}`,
      source: 'owner-delivery',
      kind: 'owner-reply-undelivered',
      severity: 'warn',
      // Resending is agent work; nothing here blocks Mason.
      blocking: false,
      title: oneLine(`Leader reply undelivered on ${reply.destinations.map(d => d.channel).join(', ')}`, TITLE_MAX) || `leader reply ${reply.id}`,
      detail: oneLine(
        reply.destinations.map(d => d.reason === null ? `${d.channel}: ${d.state}` : `${d.channel}: ${d.state} (${d.reason})`).join(' · ') +
        ` · "${oneLine(reply.text, 120)}"`,
        DETAIL_MAX) || null,
      since: reply.at,
      expiresAt: null,
      act,
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

async function draftItems(
  list: typeof listDrafts,
  listComms: (runsDir: string) => Promise<CommsDraft[]>,
  runsDir: string | undefined,
): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  // An absent store reads as an empty list; only a read failure is 'unavailable'.
  // The cos read keeps every status: an approved or rejected copy of a
  // comms-agent email draft still means the owner decided it, so it must
  // suppress the comms-agent record below.
  let drafts: Draft[] = [];
  let state: UnifiedInboxSourceState = 'healthy';
  try { drafts = await list({ runsDir }); } catch { state = 'unavailable'; }
  const pendingCos = drafts.filter(draft => draft.status === 'pending');
  const mirrored = new Set(
    drafts.map(draft => draft.source)
      .filter(source => source.startsWith('comms-agent:'))
      .map(source => source.slice('comms-agent:'.length)),
  );
  const commsDir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let commsDrafts: CommsDraft[] = [];
  let commsFailed = false;
  try { commsDrafts = await listComms(commsDir); } catch { commsFailed = true; }
  const items = [
    ...pendingCos.map((draft): Omit<UnifiedInboxItem, 'priority'> => ({
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
    })),
    // Comms-agent reply drafts that never reached the cos store (every
    // non-email transport, or an email mirror that failed to write) still
    // wait on the owner, so they list here too — one pending reply, one item.
    // The recipient stays out of the item: it can be a handle.
    ...commsDrafts
      .filter(draft => draft.status === 'pending' && !mirrored.has(draft.id))
      .map((draft): Omit<UnifiedInboxItem, 'priority'> => ({
        id: `drafts:${draft.id}`,
        source: 'drafts',
        kind: 'draft-approval',
        severity: 'info',
        blocking: true,
        title: oneLine(`Comms reply draft via ${draft.transport}`, TITLE_MAX),
        detail: oneLine(draft.subject || '(no subject)', DETAIL_MAX),
        since: Number.isNaN(Date.parse(draft.createdAt)) ? null : draft.createdAt,
        expiresAt: null,
        act: ['phm comms-agent drafts'],
      })),
  ];
  const merged: UnifiedInboxSourceState = state === 'unavailable' ? 'unavailable' : commsFailed ? 'degraded' : 'healthy';
  return { report: { state: merged, pending: items.length }, items };
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

/** The newest `work.status` envelope the scan saw for a job: its wire id (the `agents bus show` handle) and its scrubbed reason. */
interface BusFeedStatus {
  id: string;
  detail: string | null;
}

/** Feed statuses that need a decision rather than a worker: blocked waits on something, failed broke. */
const BUS_FEED_STUCK_STATUSES: ReadonlySet<string> = new Set(['blocked', 'failed']);
/** Display clip for a status report's own detail inside an item detail line. */
const STATUS_DETAIL_MAX = 160;

/**
 * Open and stuck v2 work-feed jobs, from the same read-only projection
 * `phm agents bus work feed` serves. A job counts as pending while it is
 * queued or rescheduled, declares at least one claim key, and — when the
 * coordination table is readable — at least one of those keys has no live hold.
 * A job the feed shows `blocked` or `failed` counts as pending too: it cannot
 * be claimed, it needs a decision, so it lists with the newest status report's
 * own detail and a `bus show` deep link instead of a claim act. An open job
 * that declares no claim keys at all counts the same way — `work claim`
 * refuses it `no-claim-keys`, so it is unclaimable work needing a re-announce
 * or a terminal status, not a worker; it lists with the announcement's own
 * `bus show` handle and no claim act. A `running`/`idle` job that declares
 * claim keys counts as pending only under complete hold coverage with no
 * shown live hold on any of them — the status says progress while
 * coordination proves nobody holds the scope, so the announcement is stalled
 * and only its announcer can move it; truncated, unavailable or absent hold
 * coverage can never prove that, so unproven stalls stay hidden. Unknown
 * holds list open candidates under 'degraded' rather than hiding them. A refused feed
 * lists one high item naming the retained receipt the projection blamed —
 * every announced job is hidden and every work verb refuses until that
 * receipt's TTL ends, so the refusal itself is pending work; `expiresAt` is
 * the blamed receipt's own deadline. A retryable or unreadable feed degrades
 * the section; it never invents jobs.
 */
function busFeedJobItems(options: UnifiedInboxOptions, now: number,
  posts: ReadonlyMap<string, BusFeedPost>,
  statuses: ReadonlyMap<string, BusFeedStatus>): { state: 'ok' | 'degraded' | 'unavailable'; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let feed: BusWorkFeedReadResult;
  try { feed = (options.readFeed ?? readBusWorkFeed)({ root: options.busRoot, claims: true, now: () => now }); }
  catch { return { state: 'unavailable', items: [] }; }
  if (feed.status === 'unavailable') return { state: 'unavailable', items: [] };
  if (feed.status === 'refused') {
    const receipt = feed.receipt;
    const expiry = receipt === undefined ? NaN : receipt.receivedAt + receipt.ttl;
    // ECMAScript's Date range ends at ±8.64e15 ms; an out-of-range expiry
    // stays null — unknown, never an invalid timestamp.
    const expiresAt = Number.isSafeInteger(expiry) && expiry <= 8_640_000_000_000_000 ? iso(expiry) : null;
    return { state: 'degraded', items: [{
      id: 'bus-feed-refused',
      source: 'bus',
      kind: 'bus-work',
      severity: 'high',
      blocking: false,
      title: `work feed refused: ${feed.reason}`,
      detail: cap('every announced job is hidden and work verbs refuse until the receipt expires' +
        (receipt === undefined ? '' : ` · receipt ${receipt.id}`), DETAIL_MAX),
      since: receipt === undefined ? null : iso(receipt.receivedAt),
      expiresAt,
      act: [
        ...(receipt === undefined ? [] : [`phm agents bus show ${receipt.id}`]),
        'phm agents bus work feed',
      ],
    }] };
  }
  if (feed.status !== 'ok') return { state: 'degraded', items: [] };

  const holdsKnown = feed.claims?.source !== 'unavailable';
  // Complete hold coverage is what "no live claim" proofs need: a missing
  // table is verified-empty and an untruncated available read shows every
  // hold, while unavailable, truncated or absent claims can never prove a
  // declared key is unheld.
  const holdsComplete = feed.claims !== undefined && feed.claims.source !== 'unavailable' && !feed.claims.truncated;
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
    const post = posts.get(job.id);
    // A stuck job cannot be claimed — it needs a decision — so it lists with
    // the status report that moved it here instead of a claim act. Claim keys
    // are irrelevant to that read, so empty ones still surface.
    if (BUS_FEED_STUCK_STATUSES.has(job.status)) {
      const report = statuses.get(job.id);
      items.push({
        id: `bus-feed:${job.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: job.status === 'failed' || post?.priority === 'P0' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
        detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
          (report?.detail ? ` — ${report.detail}` : ''), DETAIL_MAX),
        since: iso(job.updatedAt),
        expiresAt: post ? iso(post.expiresAt) : null,
        act: [
          ...(report === undefined ? [] : [`phm agents bus show ${report.id}`]),
          `phm agents bus work feed --job ${job.id} --claims`,
        ],
      });
      continue;
    }
    // A running/idle announcement whose declared keys all lost their live
    // holds is stalled work: the status reports progress but complete hold
    // coverage proves nobody holds the job's scope, and only the announcer
    // can move it — a worker cannot claim a non-open status. Jobs with no
    // declared keys have no claim scope to prove unheld, and incomplete
    // coverage can never prove "no hold", so both stay hidden rather than
    // listed as fact.
    if ((job.status === 'running' || job.status === 'idle') && job.claimKeys.length > 0 && holdsComplete) {
      const held = heldKeys.get(job.id);
      if (held === undefined || held.size === 0) {
        const report = statuses.get(job.id);
        items.push({
          id: `bus-feed:${job.id}`,
          source: 'bus',
          kind: 'bus-work',
          severity: post?.priority === 'P0' ? 'high' : 'warn',
          blocking: false,
          title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
          detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
            (report?.detail ? ` — ${report.detail}` : (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`)) +
            ' · no live claim on its declared keys; only the announcer can move it', DETAIL_MAX),
          since: iso(job.updatedAt),
          expiresAt: post ? iso(post.expiresAt) : null,
          act: [
            ...(report === undefined ? [] : [`phm agents bus show ${report.id}`]),
            `phm agents bus work feed --job ${job.id} --claims`,
          ],
        });
      }
      continue;
    }
    // An open job that declares no claim keys can never be claimed —
    // `work claim` refuses it `no-claim-keys` — so like a stuck job it needs
    // a decision (re-announce with keys or move it terminal), not a worker.
    // It lists with the announcement's own post handle and no claim act.
    if (BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length === 0) {
      items.push({
        id: `bus-feed:${job.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: post?.priority === 'P0' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
        detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
          (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`) +
          ' · declares no claim keys; nothing can claim it', DETAIL_MAX),
        since: iso(post?.receivedAt ?? job.updatedAt),
        expiresAt: post ? iso(post.expiresAt) : null,
        act: [`phm agents bus show ${job.postId}`, `phm agents bus work feed --job ${job.id} --claims`],
      });
      continue;
    }
    if (!BUS_FEED_OPEN_STATUSES.has(job.status) || job.claimKeys.length === 0) continue;
    const held = heldKeys.get(job.id);
    const freeKeys = holdsKnown ? job.claimKeys.filter(key => !held?.has(key)) : job.claimKeys;
    if (freeKeys.length === 0) continue;
    const claimKey = freeKeys.find(key => key.startsWith('queue:')) ?? freeKeys[0]!;
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

/** Pending bus items a waiting conversation thread must not repeat: the envelope ids behind `bus:`/`bus-handoff:` items and the job ids behind `bus-feed:` items. */
interface BusItemCoverage {
  readonly envelopes: ReadonlySet<string>;
  readonly feedJobs: ReadonlySet<string>;
}

function busItems(options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[]; covered: BusItemCoverage } {
  const covered: { envelopes: Set<string>; feedJobs: Set<string> } = { envelopes: new Set(), feedJobs: new Set() };
  const bus: BusInboxOptions = { root: options.busRoot, now: options.now };
  let inspection: BusInboxInspection;
  try { inspection = (options.inspectBus ?? inspectBusInbox)(bus); }
  catch { inspection = { source: 'unavailable', retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null }; }
  if (inspection.source !== 'available') return { report: { state: inspection.source === 'missing' ? 'missing' : 'unavailable', pending: 0 }, items: [], covered };

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
  const feedStatuses = new Map<string, BusFeedStatus>();
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
        // Cursor order is append order, so the last status seen per job is the
        // one the feed projection credits — the same rule it applies. The
        // detail is untrusted body text: scrubbed and clipped here, never raw.
        if (record.kind === 'work.status' && typeof record.jobId === 'string') {
          const detail = record.detail;
          feedStatuses.set(record.jobId, {
            id: envelope.id,
            detail: typeof detail === 'string' && detail.trim() !== '' ? oneLine(detail, STATUS_DETAIL_MAX) : null,
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
  const feed = busFeedJobItems(options, now, feedPosts, feedStatuses);
  items.push(...feed.items);
  if (feed.state === 'unavailable') state = 'unavailable';
  else if (feed.state === 'degraded' && state === 'healthy') state = 'degraded';
  for (const item of items) {
    if (item.id.startsWith('bus-feed:')) covered.feedJobs.add(item.id.slice('bus-feed:'.length));
    else if (item.id.startsWith('bus-handoff:')) covered.envelopes.add(item.id.slice('bus-handoff:'.length));
    else if (item.id.startsWith('bus:')) covered.envelopes.add(item.id.slice('bus:'.length));
  }
  return { report: { state, pending: items.length }, items, covered };
}

/** The `--thread` label rule `agents bus post` enforces: printable ASCII, 1-128 chars. */
const THREAD_LABEL = /^[\x21-\x7e]{1,128}$/;

/**
 * Agent-to-agent conversation threads still needing a person — the same
 * `state:'waiting'` and `state:'blocked'` threads the one shared
 * conversations projection computes, read unfiltered and narrowed here so
 * thread state, subjects and ages can never disagree with that surface. A
 * waiting thread names who must answer and how long it has waited; a blocked
 * thread names who reported the block, who was told and how long it has
 * stood — a reported block nothing has answered is pending work like an
 * unanswered ask. A thread whose latest message is already a pending bus
 * item — an unclaimed work envelope or a live worker-handoff — or whose
 * `job:` thread the feed already lists stays under the bus source: one
 * pending thing, one item. The source state follows the projection honestly:
 * 'missing' is a verified-empty store, 'unavailable' an unreadable one
 * (never an empty list passed off as fact), and damaged rows the tolerant
 * scan skipped degrade the read rather than let partial coverage pass as
 * complete. `since` is the state change's start; the retained envelope TTL
 * is not part of the projection, so `expiresAt` stays null — unknown, never
 * invented.
 */
function conversationItems(read: NonNullable<UnifiedInboxOptions['readConversations']>,
  options: UnifiedInboxOptions, now: () => number,
  covered: BusItemCoverage): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: AgentConversations;
  try { result = read({}, { root: options.busRoot, now }); }
  catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  if (result.source === 'unavailable' || result.conversations === null) {
    return { report: { state: 'unavailable', pending: 0 }, items: [] };
  }
  if (result.source === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const thread of result.conversations) {
    // Answered and done threads are history, not pending work.
    if (thread.state !== 'waiting' && thread.state !== 'blocked') continue;
    const last = thread.messages[thread.messages.length - 1];
    if (last === undefined) continue;
    if (covered.envelopes.has(last.id)) continue;
    if (thread.id.startsWith(JOB_THREAD_PREFIX) && covered.feedJobs.has(thread.id.slice(JOB_THREAD_PREFIX.length))) continue;
    const act = ['phm agents conversations', `phm agents bus show ${last.id}`];
    // The reply template only prints when the conversation key is itself a
    // label `agents bus post --thread` accepts; a key beyond the label bound
    // keeps the inspect acts rather than a command that cannot run.
    if (THREAD_LABEL.test(thread.id)) {
      act.push(`phm agents bus post --to <sender-label> --text "<reply>" --thread ${thread.id}`);
    }
    const title = oneLine(thread.subject, TITLE_MAX) || `agent thread ${thread.id}`;
    const count = `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`;
    if (thread.state === 'waiting' && thread.waiting !== null) {
      items.push({
        id: `conversations:${thread.id}`,
        source: 'conversations',
        kind: 'agent-thread',
        // A handoff waiting on a recipient is delegated work nobody picked up;
        // an ask is ordinary coordination. Neither blocks Mason, so never `blocking`.
        severity: last.kind === 'handoff' ? 'warn' : 'info',
        blocking: false,
        title,
        detail: cap(`from ${last.from} · waiting on ${thread.waiting.on} · ${count} · waiting ${plainAge(thread.waiting.ms)}`, DETAIL_MAX),
        since: thread.waiting.since,
        expiresAt: null,
        act,
      });
    } else if (thread.state === 'blocked') {
      items.push({
        id: `conversations:${thread.id}`,
        source: 'conversations',
        kind: 'agent-thread',
        // Unblocking a reported block is agent work, never Mason-blocking —
        // warn like a handoff wait, non-blocking like every thread item.
        severity: 'warn',
        blocking: false,
        title,
        detail: cap(`from ${last.from} · to ${last.to} · ${thread.stateText} for ${plainAge(now() - Date.parse(thread.lastAt))} · ${count}`, DETAIL_MAX),
        since: thread.lastAt,
        expiresAt: null,
        act,
      });
    }
  }
  return { report: { state: result.skipped > 0 ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** Work refs named inside one seat item's detail line before the overflow count takes over. */
const SEAT_DETAIL_REFS = 4;

/**
 * Bot seats whose projected handoff plan still has work to move — the same
 * `planSeatHandoffs` read `phm bots handoffs` serves, so this source and that
 * surface can never disagree. Only eligible seats with pending (not yet
 * journaled) handoff records list: a draining seat with nothing left to
 * release is already on its way to idle, not pending work, and an ineligible
 * seat's held work is not a handoff candidate. Seat handoffs are agent work,
 * never Mason-blocking, so items are warn and non-blocking; `since` stays
 * null because the plan stamps records at the read instant, not at a real
 * age, and `expiresAt` stays null — unknown, never invented. An empty roster
 * is 'missing' (no seats configured); a throwing or refused plan read is
 * 'unavailable', never an empty plan passed off as fact.
 */
async function seatItems(read: NonNullable<UnifiedInboxOptions['readSeatHandoffs']>,
  now: () => number): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  let plan: SeatHandoffsPlan;
  try { plan = await read({ now }); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  if (plan.seats.length === 0) return { report: { state: 'missing', pending: 0 }, items: [] };
  const items = plan.seats
    .filter(seat => seat.eligible && seat.handoffs.length > 0)
    .map((seat): Omit<UnifiedInboxItem, 'priority'> => {
      const count = seat.handoffs.length;
      const refs = seat.handoffs.slice(0, SEAT_DETAIL_REFS)
        .map(handoff => `${handoff.work.kind} ${handoff.work.ref}`).join(', ');
      const overflow = count > SEAT_DETAIL_REFS ? ` +${count - SEAT_DETAIL_REFS} more` : '';
      return {
        id: `seats:${seat.seatId}`,
        source: 'seats',
        kind: 'seat-handoff',
        severity: 'warn',
        blocking: false,
        title: oneLine(`Seat ${seat.seatId} (${seat.state}): ${count} pending handoff${count === 1 ? '' : 's'}`, TITLE_MAX),
        detail: oneLine(`${seat.state} · ${refs}${overflow}`, DETAIL_MAX),
        since: null,
        expiresAt: null,
        act: [
          `phm bots handoff --seat ${seat.seatId}`,
          `phm bots handoff --seat ${seat.seatId} --apply`,
          'phm bots handoffs',
        ],
      };
    });
  return { report: { state: 'healthy', pending: items.length }, items };
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

/** The request TTL dispatch will apply, resolved read-only: cfg.comms.requestTtlHours with the same 48h fallback `expireStaleRequests` gets. */
function requestTtlMs(): number {
  try { return commsRequestTtlMs(loadConfigReadOnly()); }
  catch { return DEFAULT_REQUEST_TTL_HOURS * 3_600_000; }
}

/** Same shape guard `inbox show` applies to proposal ids before one reaches a command line. */
const PROPOSAL_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

/**
 * Comms questions and approvals still owed an answer — the live request queue
 * behind `phm comms status`. A `sent` question/approval is the single
 * outstanding slot Mason's numbered reply or button tap resolves, so it
 * lists as a blocking warn; a `pending` one is queued behind the slot or the
 * question cooldown and lists as info. Informational `report` requests never
 * await a reply and never list, matching the dispatch split. `since` and
 * `expiresAt` come from the same age-start and TTL rule
 * `expireStaleRequests` applies, so a request about to age out ranks as the
 * deadline it really is. An unreadable store reports 'unavailable'; a
 * missing one 'missing' — never an empty queue passed off as fact.
 */
function requestItems(read: typeof readCommsRequests, now: () => number, ttlOverride?: number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: CommsRequestsRead;
  try { result = read(); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  if (result.status === 'unavailable') return { report: { state: 'unavailable', pending: 0 }, items: [] };
  if (result.status === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  // A malformed store row must never take the whole inbox down.
  const candidates = result.requests.filter(r =>
    r !== null && typeof r === 'object' &&
    (r.type === 'question' || r.type === 'approval') && (r.status === 'pending' || r.status === 'sent'));
  if (candidates.length === 0) return { report: { state: 'healthy', pending: 0 }, items: [] };
  const nowMs = now();
  const ttlMs = ttlOverride ?? requestTtlMs();
  const items = candidates.map((r): Omit<UnifiedInboxItem, 'priority'> => {
    const sent = r.status === 'sent';
    const start = commsRequestAgeStartMs(r);
    const timed = Number.isFinite(start);
    const act = ['phm comms status'];
    const proposalId = r.meta?.['proposalId'];
    if (typeof proposalId === 'string' && PROPOSAL_ID.test(proposalId)) act.push(`phm inbox show ${proposalId}`);
    return {
      id: `requests:${r.id}`,
      source: 'requests',
      kind: 'comms-request',
      severity: sent ? 'warn' : 'info',
      // Until Mason answers or it expires, a sent request holds the question slot.
      blocking: sent,
      title: oneLine(r.text, TITLE_MAX) || `comms ${r.type} ${r.id.slice(0, 8)}`,
      detail: cap(`${r.type} · ${r.kind} · ${sent ? 'awaiting reply' : 'queued'}` +
        (r.options.length > 0 ? ` · ${r.options.length} option${r.options.length === 1 ? '' : 's'}` : '') +
        (timed ? ` · waiting ${plainAge(nowMs - start)}` : ''), DETAIL_MAX),
      since: timed ? new Date(start).toISOString() : null,
      expiresAt: timed ? new Date(start + ttlMs).toISOString() : null,
      act,
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * Pending team approvals — access requests and consequential handoffs only
 * an owner/admin can decide — from the same `readTeamApprovals` section
 * `phm approvals` and the desktop Approvals panel project, scoped to
 * DEFAULT_TEAM like the bare command. The requested action is held until
 * `phm team approve|deny` records the decision, so each lists as a blocking
 * warn with the projection's own approve command first and the matching deny
 * command second. The item carries no timestamp, so `since`/`expiresAt` stay
 * null — unknown, never invented. A throwing or refused read reports
 * 'unavailable', never an empty approvals list passed off as fact.
 */
function teamApprovalItems(read: NonNullable<UnifiedInboxOptions['readTeamApprovals']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let section: ReturnType<typeof readTeamApprovals>;
  try { section = read(DEFAULT_TEAM); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  if (section.state !== 'ok') return { report: { state: 'unavailable', pending: 0 }, items: [] };
  const items = section.items.map((approval: TeamApprovalItem): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `team-approvals:${approval.id}`,
    source: 'team-approvals',
    kind: 'team-approval',
    severity: 'warn',
    // The access request or handoff stays held until an owner/admin decides.
    blocking: true,
    title: oneLine(approval.summary, TITLE_MAX) || `team approval ${approval.id}`,
    detail: oneLine(`from ${approval.requestedBy}${approval.note ? ` · "${approval.note}"` : ''}`, DETAIL_MAX) || null,
    since: null,
    expiresAt: null,
    act: [approval.command, `phm team deny ${approval.id} --team ${DEFAULT_TEAM}`, 'phm approvals'],
  }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * Pending inbox proposals — proposed outward actions that never auto-apply —
 * from the same `readPendingProposals` section `phm approvals` and the
 * desktop Approvals panel project. Each lists as info: a review backlog, not
 * an urgent decision. `phm inbox show` reviews first, then approve and
 * reject; a partial capture can be denied but never approved, so its acts
 * drop `approve`. A proposal id that fails the inbox-show shape guard keeps
 * only the bare `phm inbox` list link rather than a command that cannot
 * run. `since` is the proposal's real createdAt — null when it does not
 * parse, never invented; `expiresAt` stays null. An 'ok' read whose coverage
 * was truncated, or an 'unavailable' read that still returned items, reports
 * 'degraded': the items found are real and list while the missing remainder
 * is honestly unknown — never an empty list passed off as fact.
 */
function proposalItems(read: NonNullable<UnifiedInboxOptions['readInboxProposals']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let section: ReturnType<typeof readPendingProposals>;
  try { section = read(); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  const items = section.items.map((proposal: ProposalApprovalItem): Omit<UnifiedInboxItem, 'priority'> => {
    const idOk = PROPOSAL_ID.test(proposal.id);
    const act = idOk
      ? [`phm inbox show ${proposal.id}`,
        ...(proposal.partial ? [] : [`phm inbox approve ${proposal.id}`]),
        `phm inbox reject ${proposal.id}`]
      : ['phm inbox'];
    const created = typeof proposal.createdAt === 'string' ? Date.parse(proposal.createdAt) : Number.NaN;
    return {
      id: `proposals:${proposal.id}`,
      source: 'proposals',
      kind: 'inbox-proposal',
      severity: 'info',
      blocking: false,
      title: oneLine(proposal.title, TITLE_MAX) || `inbox proposal ${proposal.id}`,
      detail: oneLine(`${proposal.kind} proposal${proposal.partial ? ' · partial capture' : ''}` +
        (proposal.detail === null ? '' : ` — ${proposal.detail}`), DETAIL_MAX) || null,
      since: Number.isFinite(created) ? proposal.createdAt : null,
      expiresAt: null,
      act,
    };
  });
  const state: UnifiedInboxSourceState = section.state !== 'ok'
    ? (items.length > 0 ? 'degraded' : 'unavailable')
    : section.truncated ? 'degraded' : 'healthy';
  return { report: { state, pending: items.length }, items };
}

/**
 * The same read `phm fleet email-outbox` serves, resolved at the shared runs
 * dir: saved email-drop config → outbox dir (`outboxDir`, else the sibling of
 * `inboxDir`, the rule every consumer applies) → availability probe →
 * `readEmailOutbox`. A missing config or outbox is 'missing'; a config that
 * exists but cannot be used is 'degraded' (the gmail plan-file rule); a probe
 * or listing failure is 'unavailable' — a broken drop folder never reports a
 * healthy empty outbox. Rows are stripped to name/state/reason so recipients,
 * subjects, bodies and paths cannot reach the inbox even by accident.
 */
async function readEmailOutboxSource(runsDir: string): Promise<EmailOutboxSourceRead> {
  const none = (state: UnifiedInboxSourceState): EmailOutboxSourceRead => ({ state, entries: [] });
  let saved: Awaited<ReturnType<typeof readEmailDropConfig>>;
  try { saved = await readEmailDropConfig(runsDir); } catch { return none('unavailable'); }
  if (saved.state === 'missing') return none('missing');
  if (saved.state !== 'ok' || saved.config === undefined) return none('degraded');
  const outboxDir = saved.config.outboxDir ?? join(saved.config.inboxDir, '..', 'outbox');
  let availability: ReturnType<typeof probeOutboxDir>;
  try { availability = probeOutboxDir(outboxDir); } catch { return none('unavailable'); }
  if (availability === 'missing') return none('missing');
  if (availability !== 'ok') return none('unavailable');
  let listing: EmailOutboxListing;
  try { listing = readEmailOutbox(outboxDir); } catch { return none('unavailable'); }
  return {
    state: 'healthy',
    entries: listing.entries.map((entry): EmailOutboxSourceEntry => entry.reason === undefined
      ? { name: entry.name, state: entry.state }
      : { name: entry.name, state: entry.state, reason: entry.reason }),
  };
}

/**
 * `.reply.eml` artifacts the email send pass marked `stuck` — interrupted
 * send claims, oversized or unreadable files, malformed drafted rows. A stuck
 * reply is a recorded delivery failure the owner may be waiting on, and today
 * only `phm fleet email-outbox` and `phm comms diagnose` surface it, so each
 * lists as a warn with the fixed reason and a deep link. A stuck artifact is
 * never auto-resent, so items are non-blocking; entries carry no timestamp,
 * so `since`/`expiresAt` stay null — unknown, never invented. Queued, sent
 * and drafted rows are the send pass's own concern and never list here.
 */
async function emailOutboxItems(read: NonNullable<UnifiedInboxOptions['readEmailOutbox']>,
  runsDir: string | undefined): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: EmailOutboxSourceRead;
  try { result = await read({ runsDir: dir }); } catch { return { report: { state: 'unavailable', pending: 0 }, items: [] }; }
  const items = result.entries.filter(entry => entry.state === 'stuck').map((entry): Omit<UnifiedInboxItem, 'priority'> => ({
    // Artifact names are filenames and can carry secret-shaped text; the id stays opaque.
    id: `email-outbox:${createHash('sha256').update(entry.name).digest('hex').slice(0, 16)}`,
    source: 'email-outbox',
    kind: 'email-stuck',
    severity: 'warn',
    blocking: false,
    title: oneLine(`Stuck email reply ${entry.name}`, TITLE_MAX),
    detail: oneLine(`reason ${entry.reason ?? 'unknown'}`, DETAIL_MAX),
    since: null,
    expiresAt: null,
    act: ['phm fleet email-outbox', 'phm comms diagnose --json'],
  }));
  return { report: { state: result.state, pending: items.length }, items };
}

/**
 * One read-only pass over every pending comms source. Never throws; a failed
 * source reports its state and the rest still list.
 */
export async function readUnifiedInbox(options: UnifiedInboxOptions = {}): Promise<UnifiedInbox> {
  const now = options.now ?? Date.now;
  const needs = needsYouItems(options.readNeeds ?? readNeedsMason, options.runsDir);
  const teammates = teammateItems(options.readTexts ?? readTeammateTexts, options.runsDir, now);
  const ownerThread = ownerThreadItems(options.readOwnerAwaiting ?? readOwnerAwaitingReplies, options.runsDir);
  const ownerDelivery = ownerDeliveryItems(options.readOwnerUndelivered ?? readOwnerUndeliveredReplies, options.runsDir);
  const drafts = await draftItems(options.listPendingDrafts ?? listDrafts, options.listCommsDrafts ?? listCommsAgentDrafts, options.runsDir);
  const bus = busItems(options);
  const conversations = conversationItems(options.readConversations ?? readAgentConversations, options, now, bus.covered);
  const seats = await seatItems(options.readSeatHandoffs ?? planSeatHandoffs, now);
  const gmail = gmailItems(options.readGmailPlans ?? readGmailArchivePlanLatest, options.runsDir);
  const linkedin = linkedInItems(options.readLinkedIn ?? readLinkedInDrop, options.runsDir, now);
  const requests = requestItems(options.readRequests ?? readCommsRequests, now, options.requestTtlMs);
  const emailOutbox = await emailOutboxItems(
    options.readEmailOutbox ?? (async (opts: { runsDir?: string }) => readEmailOutboxSource(opts.runsDir ?? join(homedir(), '.ashlr-runs'))),
    options.runsDir);
  const teamApprovals = teamApprovalItems(options.readTeamApprovals ?? readTeamApprovals);
  const proposals = proposalItems(options.readInboxProposals ?? readPendingProposals);

  const sources: UnifiedInbox['sources'] = {
    'needs-you': needs.report,
    imessage: teammates.report,
    'owner-thread': ownerThread.report,
    'owner-delivery': ownerDelivery.report,
    drafts: drafts.report,
    bus: bus.report,
    conversations: conversations.report,
    seats: seats.report,
    gmail: gmail.report,
    linkedin: linkedin.report,
    requests: requests.report,
    'email-outbox': emailOutbox.report,
    'team-approvals': teamApprovals.report,
    proposals: proposals.report,
  };
  const pending: Omit<UnifiedInboxItem, 'priority'>[] = [...needs.items, ...teammates.items, ...ownerThread.items, ...ownerDelivery.items, ...drafts.items, ...bus.items, ...conversations.items, ...seats.items, ...gmail.items, ...linkedin.items, ...requests.items, ...emailOutbox.items, ...teamApprovals.items, ...proposals.items];
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
