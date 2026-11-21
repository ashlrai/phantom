/**
 * `agents bus work mine`: one read answering "what is pending for this agent" —
 * the live claims it holds under any of its labels, the open work-feed jobs it
 * could still claim, the work-feed jobs it announced that have not finished —
 * each with the live claim coverage of its declared keys —
 * the claimable work envelopes and worker-handoff
 * assignments addressed to it — under any of its labels or to a channel it
 * belongs to — in `bus next` order, the conversation threads waiting on its
 * answer, the conversation threads it is waiting on, the blocked conversation
 * threads it is a party to, the wake hints addressed to
 * it, the next page of mail in its inbox and the pending mail the legacy
 * `phm bus` mailbox still holds for any of its labels. Each section reads the same
 * projection the dedicated verb
 * serves and keeps its honesty rules: an unreadable store, coordination table,
 * registry or wake queue narrows the match or reports unknown, never an empty
 * list passed off as fact. Routing labels are not authentication; claims
 * coordinate scope and grant no execution authority. Read-only: no writes, no
 * claims, no dispatch.
 */
import { coordinationRowBlocks, listCoordination } from './claim-store.js';
import { dirname } from 'node:path';
import { listBusClaims, type BusClaimsListClaim, type BusClaimsOwnerMatch } from './bus-claims.js';
import { agentLabels, agentPendingAddressMatcher, readAgentRegistry, resolveAgent, type AgentIdentity, type AgentRegistry } from './bus-identity.js';
import { agentName, type AgentMessageKind } from '../fleet/agent-messages.js';
import { readAgentConversations, type AgentConversations } from '../fleet/agent-conversations.js';
import { plainAge } from '../fleet/agent-conversation-model.js';
import { BUS_FEED_OPEN_STATUSES, busWorkFeedHoldIndex, busWorkFeedJobHold, busWorkFeedOwnerMatcher, busWorkFeedToMatcher,
  readBusWorkFeed, type BusWorkFeedHoldCoverage, type BusWorkFeedJob, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { agentWakeClaimHolderSuffix, busBodyFallbackSummary, busBodySummary, busInboxJobMarker, readAgentInbox, readAgentWakes,
  type AgentWakeRow, type BusEnvelopeLookupJob, type InboxKind } from './bus-unified.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { BUS_PROTOCOL_KEY, BUS_PRIORITIES, isClaimableWork,
  type BusPriority } from '../fleet/bus-envelope.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { isWorkerHandoffBody } from '../fleet/handoff-body.js';
import { createBusMailbox } from '../fleet/bus-mailbox.js';
import { scrubSecrets } from '../util/scrub.js';

export interface BusWorkMineOptions {
  /** Fleet root shared by the bus store, identity registry and coordination table. */
  root?: string;
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  /** ASHLR home owning the legacy `bus-mailbox` store (`$ASHLR_HOME/bus-mailbox`);
   * default `dirname(root)` when `root` is set — the fleet root's parent — else `ashlrHome()`. */
  mailboxHome?: string;
  /** Injectable clock, frozen once so every section reads the same instant. */
  now?: () => number;
}

/** How completely the coordination holds behind the feed are known. */
export type BusWorkMineHoldCoverage = BusWorkFeedHoldCoverage;

/** An open feed job plus its per-key hold state; a null field means unknown, never none. */
export interface BusWorkMineJob extends BusWorkFeedJob {
  /** True when the announcement `to` label resolves to this agent's identity; false keeps exact-label misses honest. */
  addressed: boolean;
  /** True when the job's `owner` (announcer) label resolves to this agent's identity — the agent posted it and owns its status reports; false keeps exact-label misses honest. */
  announced: boolean;
  /** Declared keys with no shown live hold — null unless hold coverage is complete. */
  freeKeys: string[] | null;
  /** Declared keys with at least one shown live hold — null when the hold set itself is unknown. */
  heldKeys: string[] | null;
  /** true: a declared key is provably free; false: every declared key is provably held; null: coverage incomplete. */
  claimable: boolean | null;
}

export interface BusWorkMineAgent {
  /** The routing ref exactly as passed. */
  ref: string;
  /** Resolved handle; null when the ref is not a registered identity. */
  handle: string | null;
  /** Stable id the ref resolved to; null likewise. */
  identity: string | null;
  /** Registry state behind the resolution; 'unavailable' means same-identity labels may be missed. */
  registry: 'missing' | 'available' | 'unavailable';
}

export type BusWorkMineClaims =
  | { status: 'ok'; source: 'missing' | 'available'; claims: BusClaimsListClaim[];
      owner: BusClaimsOwnerMatch }
  | { status: 'unavailable' };

export type BusWorkMineJobs =
  | { status: 'ok'; holds: BusWorkMineHoldCoverage; open: number; receipts: number;
      truncated: boolean; jobs: BusWorkMineJob[] }
  | { status: 'refused'; reason: Extract<BusWorkFeedReadResult, { status: 'refused' }>['reason'];
      receipts: number; receipt?: Extract<BusWorkFeedReadResult, { status: 'refused' }>['receipt'] }
  | { status: 'unavailable' | 'retryable' | 'invalid' };

/** An announced feed job plus the live claim coverage of its declared keys. */
export interface BusWorkMineAnnouncedJob extends BusWorkFeedJob {
  /** true: a declared key has a shown live hold; false: complete coverage proves none is held, or the job declares no keys a hold could cover; null: coverage cannot prove either way. */
  held: boolean | null;
  /** Declared keys with at least one shown live hold — a lower bound under truncated coverage; null when the hold set itself is unknown. */
  heldKeys: string[] | null;
  /** Declared keys with no shown live hold — proven only under complete coverage; null otherwise. */
  freeKeys: string[] | null;
}

/** The feed jobs the agent announced that have not reached a terminal state. */
export type BusWorkMineAnnounced =
  | { status: 'ok'; matched: number; items: BusWorkMineAnnouncedJob[];
      /** True only when live announced jobs remain beyond the shown page. */
      truncated: boolean }
  | { status: 'refused'; reason: Extract<BusWorkFeedReadResult, { status: 'refused' }>['reason'];
      receipts: number; receipt?: Extract<BusWorkFeedReadResult, { status: 'refused' }>['receipt'] }
  | { status: 'unavailable' | 'retryable' | 'invalid' };

export type BusWorkMineWakes =
  | { status: 'ok'; agent: string;
      /** Same scope `readAgentWakes` reports: 'identity' for a registered ref, 'label' for the literal-`to` fallback. */
      scope: 'identity' | 'label';
      wakes: AgentWakeRow[];
      /** Every wake hint the bounded queue tail matched for the agent before its row cap; `wakes` shows only the newest digest cap. */
      matched: number;
      /** The queue tail or a row cap cut matches beyond `wakes` — matched is then a lower bound, never proven total. */
      truncated: boolean }
  | { status: 'unknown-agent' | 'unavailable'; reason: string };

/** One mail row addressed to the agent, summarized the way the inbox frame reads it. */
export interface BusWorkMineInboxMessage {
  cursor: number;
  /** Envelope id — the handle the message-id claim verbs take. */
  id: string;
  ts: string;
  priority: BusPriority;
  kind: InboxKind;
  /** Channel name for channel posts; null otherwise. */
  channel: string | null;
  /** Raw sender routing label; `fromAgent` is its resolved handle or null. */
  from: string;
  fromAgent: string | null;
  /** Scrubbed, single-line body summary, clipped to the digest bound. */
  summary: string;
  /** Same tri-state hold evidence `agents bus inbox` reports, present only on
   * claimable work and worker-handoff mail: true/false when provable, null
   * when a hold store cannot be read — never a guess; absent on other mail. */
  held?: boolean | null;
  /** Owner label of the blocking claim when held and known; null otherwise. */
  holder?: string | null;
  /** `work.post`/`work.status` mail only: the live feed state of the `jobId`
   * the body cites — the same `BusEnvelopeLookupJob` `agents bus show`
   * resolves, read once per inbox page; absent on every other body kind. */
  job?: BusEnvelopeLookupJob;
}

export type BusWorkMineInbox =
  | { status: 'ok'; agent: string; messages: BusWorkMineInboxMessage[];
      /** Resume cursor for `agents bus inbox --after`; covers every scanned row. */
      nextCursor: number;
      /** Every pending mail row the inbox match rules accept across the
       * retained store; `messages` shows only the oldest cap. */
      matched: number;
      /** True only when mail beyond the shown page provably exists. */
      truncated: boolean }
  | { status: 'unknown-agent' | 'unavailable' | 'retryable' | 'invalid'; reason: string };

/** One pending legacy `phm bus` mailbox message addressed to any of the agent's labels. */
export interface BusWorkMineMailboxMessage {
  /** Envelope id — the handle `phm bus ack <id> --to <to>` takes. */
  id: string;
  /** The agent label the mail is addressed to — pass it verbatim as `--to` to `phm bus inbox`/`ack`. */
  to: string;
  /** Raw sender routing label. */
  from: string;
  priority: BusPriority;
  /** ISO of the store acceptance time. */
  ts: string;
  /** ISO expiry (acceptance plus TTL); every listed row is unexpired at the frozen instant. */
  expiresAt: string;
  /** Scrubbed, single-line body summary, clipped to the digest bound. */
  summary: string;
}

export type BusWorkMineMailbox =
  | { status: 'ok'; agent: string; messages: BusWorkMineMailboxMessage[];
      /** Every pending legacy-mail row across the agent's labels before the display cap. */
      matched: number;
      /** True only when pending rows remain beyond the shown page. */
      truncated: boolean }
  | { status: 'unavailable'; reason: string };

/** One live claimable work envelope addressed to the agent, in `bus next` claim order. */
export interface BusWorkMineNextItem {
  cursor: number;
  /** Envelope id — the handle the message-id claim verbs take. */
  id: string;
  /** Raw `to` routing label the envelope was addressed to — one of the agent's labels or a `group:<channel>:<topic>` address of a channel it belongs to. */
  to: string;
  priority: BusPriority;
  /** ISO receipt time. */
  ts: string;
  /** ISO expiry of the retained envelope; it stops being claimable then. */
  expiresAt: string;
  /** Which claimable body kind this is: legacy `work` or protocol-v1 `task`. */
  kind: 'work' | 'task';
  /** Raw sender routing label; `fromAgent` is its resolved handle or null. */
  from: string;
  fromAgent: string | null;
  /** Scrubbed, single-line body summary, clipped to the digest bound. */
  summary: string;
  /** true: a taken claim row (live lease or completed) or coordination hold provably covers it; false: provably free; null: hold coverage unknown. */
  held: boolean | null;
  /** Owner label of the blocking claim when held and known; null otherwise. */
  holder: string | null;
}

export type BusWorkMineNext =
  | { status: 'ok';
      /** complete: both claim stores were read, so `held` is provable per item; unknown: a store could not be read. */
      holds: 'complete' | 'unknown';
      /** Every live claimable envelope addressed to the agent, before the display cap. */
      matched: number;
      items: BusWorkMineNextItem[];
      /** True only when matched items remain beyond the shown page. */
      truncated: boolean }
  | { status: 'unavailable' | 'retryable' | 'invalid'; reason: string };

/** One live worker-handoff assignment addressed to the agent. */
export interface BusWorkMineHandoff {
  cursor: number;
  /** Envelope id — the handle `fleet handoff-receive --id` and `handoff-reply --id` take. */
  id: string;
  /** Raw `to` routing label — pass it verbatim as `handoff-receive --to`/`handoff-reply --to`; a channel-addressed handoff matches only its literal `group:<channel>:<topic>` label. */
  to: string;
  /** Fleet job id the handoff body carries; the same id its snapshot must name. */
  taskId: string;
  priority: BusPriority;
  /** ISO receipt time. */
  ts: string;
  /** ISO expiry of the retained envelope; it stops being receivable then. */
  expiresAt: string;
  /** Raw sender routing label; `fromAgent` is its resolved handle or null. */
  from: string;
  fromAgent: string | null;
  /** Scrubbed, single-line body summary, clipped to the digest bound. */
  summary: string;
  /** Same tri-state hold rule as `next` items: a taken claim or coordination
   * hold on the envelope is reported, never a guess; receiving a handoff does
   * not check claims, so `held` is evidence, not a gate. */
  held: boolean | null;
  /** Owner label of the blocking claim when held and known; null otherwise. */
  holder: string | null;
}

export type BusWorkMineHandoffs =
  | { status: 'ok';
      /** complete: both claim stores were read, so `held` is provable per item; unknown: a store could not be read. */
      holds: 'complete' | 'unknown';
      /** Every live worker-handoff envelope addressed to the agent, before the display cap. */
      matched: number;
      items: BusWorkMineHandoff[];
      /** True only when matched items remain beyond the shown page. */
      truncated: boolean }
  | { status: 'unavailable' | 'retryable' | 'invalid'; reason: string };

/** One conversation thread whose latest message still wants this agent's answer. */
export interface BusWorkMineThread {
  /** Conversation key the thread groups under: a declared thread label, `job:<id>` or the root message id. */
  id: string;
  /** Envelope id of the message now waiting — `agents bus show <messageId>` resolves it. */
  messageId: string;
  /** The waiting message's kind: an ask or a handoff. */
  kind: 'ask' | 'handoff';
  /** Who must answer, as the conversation projection names it: the agent's own label or a `group:<channel>:<topic>` address. */
  waitingOn: string;
  /** How long the thread has waited at the frozen read instant, ms. */
  waitingMs: number;
  /** ISO of the waiting (latest) message — the wait's start. */
  lastAt: string;
  messageCount: number;
  /** Sender name of the waiting message, routing prefixes stripped as `agents conversations` shows it. */
  from: string;
  /** Resolved handle of that sender; null when unregistered or the registry is unreadable. */
  fromAgent: string | null;
  /** Scrubbed one-line subject of the waiting message. */
  subject: string;
}

export type BusWorkMineThreads =
  | { status: 'ok'; source: 'missing' | 'available'; matched: number;
      items: BusWorkMineThread[]; truncated: boolean; skipped: number }
  | { status: 'unavailable'; reason: string };

/** One conversation thread whose latest message the agent sent and which still waits on another party's reply. */
export interface BusWorkMineAwaitingItem {
  /** Conversation key the thread groups under: a declared thread label, `job:<id>` or the root message id. */
  id: string;
  /** Envelope id of the agent's waiting (latest) message — `agents bus show <messageId>` resolves it. */
  messageId: string;
  /** The waiting message's kind: an ask or a handoff. */
  kind: 'ask' | 'handoff';
  /** Who owes the reply, as the conversation projection names it: the recipient label of the agent's waiting message — an agent label, a topic or a `group:<channel>:<topic>` address. */
  waitingOn: string;
  /** Resolved handle of the party owing the reply; null when the label names no registered identity — a topic or channel address — or the registry is unreadable. */
  waitingOnAgent: string | null;
  /** How long the thread has waited at the frozen read instant, ms. */
  waitingMs: number;
  /** ISO of the waiting (latest) message — the wait's start. */
  lastAt: string;
  messageCount: number;
  /** Sender name of the waiting message — the agent's own label, as the projection shows it. */
  from: string;
  /** Resolved handle of that sender; null when unregistered or the registry is unreadable. */
  fromAgent: string | null;
  /** Scrubbed one-line subject of the waiting message. */
  subject: string;
}

export type BusWorkMineAwaiting =
  | { status: 'ok'; source: 'missing' | 'available'; matched: number;
      items: BusWorkMineAwaitingItem[]; truncated: boolean; skipped: number }
  | { status: 'unavailable'; reason: string };

/** One conversation thread in a blocked state the agent is a party to. */
export interface BusWorkMineBlockedItem {
  /** Conversation key the thread groups under: a declared thread label, `job:<id>` or the root message id. */
  id: string;
  /** Envelope id of the latest message — the block report `agents bus show` resolves. */
  messageId: string;
  /** The latest message's kind as the conversation projection classifies it. */
  kind: AgentMessageKind;
  /** Sender name of the latest message, routing prefixes stripped as `agents conversations` shows it. */
  from: string;
  /** Resolved handle of that sender; null when unregistered or the registry is unreadable. */
  fromAgent: string | null;
  /** Recipient name of the latest message — who the block report was addressed to. */
  to: string;
  /** ISO of the latest message — when the thread entered or last moved in its blocked state. */
  lastAt: string;
  /** How long the thread has stood blocked at the frozen read instant, ms. */
  blockedMs: number;
  messageCount: number;
  /** Scrubbed one-line subject of the latest message. */
  subject: string;
}

export type BusWorkMineBlocked =
  | { status: 'ok'; source: 'missing' | 'available'; matched: number;
      items: BusWorkMineBlockedItem[]; truncated: boolean; skipped: number }
  | { status: 'unavailable'; reason: string };

export type BusWorkMineResult =
  | { status: 'ok'; agent: BusWorkMineAgent; asOf: string;
      claims: BusWorkMineClaims; jobs: BusWorkMineJobs; announced: BusWorkMineAnnounced;
      next: BusWorkMineNext;
      handoffs: BusWorkMineHandoffs; threads: BusWorkMineThreads; awaiting: BusWorkMineAwaiting;
      blocked: BusWorkMineBlocked;
      wakes: BusWorkMineWakes; inbox: BusWorkMineInbox; mailbox: BusWorkMineMailbox }
  | { status: 'invalid'; reason: string };

/** Newest open jobs, newest wake hints and next inbox page a digest shows; totals stay honest via `open`/`matched`/`truncated`. */
const WORK_MINE_JOBS_MAX = 50;
const WORK_MINE_WAKES_MAX = 20;
const WORK_MINE_INBOX_MAX = 20;
/** Pending legacy `phm bus` mailbox rows a digest shows, drain order; `matched` keeps the true total. */
const WORK_MINE_MAILBOX_MAX = 20;
/** Claimable envelopes and handoffs a digest shows in claim order; `matched` keeps the true total. */
const WORK_MINE_NEXT_MAX = 10;
const WORK_MINE_HANDOFFS_MAX = 20;
/** Live announced jobs a digest shows, newest update first; `matched` keeps the true total. */
const WORK_MINE_ANNOUNCED_MAX = 50;
/** Waiting conversation threads a digest shows per direction, longest wait first; `matched` keeps the true total. */
const WORK_MINE_THREADS_MAX = 20;
/** Blocked conversation threads a digest shows, longest-standing first; `matched` keeps the true total. */
const WORK_MINE_BLOCKED_MAX = 20;
/** Bounded scan over the retained store, same page bound the inbox reader uses. */
const WORK_MINE_NEXT_MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
/** Display clip for one mail summary; the digest carries no raw body, so JSON and human output share it. */
const WORK_MINE_SUMMARY_MAX = 200;

const AGENT_REF = /^[\x21-\x7e]{1,128}$/;

/**
 * The hold-coverage rule every "is this job claimable" surface shares lives
 * in `busWorkFeedJobHold` (`bus-work-feed-read.ts`); this adds the two
 * agent-relative flags on top. `claimable` is true only on a provably free
 * key, false only when every declared key is provably held, and `null`
 * whenever coverage is `truncated` or `unknown` — never a guess.
 */
export function busWorkMineJobAnnotation(
  job: BusWorkFeedJob, held: ReadonlySet<string> | undefined, coverage: BusWorkMineHoldCoverage,
  addressed: boolean, announced = false,
): BusWorkMineJob {
  return { ...job, addressed, announced, ...busWorkFeedJobHold(job, held, coverage) };
}

/**
 * The announced-side annotation: the same per-key hold evidence the jobs
 * section reports, summarized as `held` — whether any declared key has a
 * shown live hold. A shown hold is real under any coverage; `false` takes a
 * complete hold list or a job with no declared keys (nothing a hold could
 * cover, provable without reading the table); `null` is everything coverage
 * cannot prove, including a truncated list with no shown holds. A
 * non-terminal job reporting `running`/`idle` with `held:false` has no live
 * claim on its declared scope — the digest shows that evidence; only the
 * announcer may move the job.
 */
export function busWorkMineAnnouncedAnnotation(
  job: BusWorkFeedJob, held: ReadonlySet<string> | undefined, coverage: BusWorkMineHoldCoverage,
): BusWorkMineAnnouncedJob {
  // The feed annotates open jobs with `claimable`; announced items report the
  // `held` tri-state instead, so the feed-level field does not leak through.
  const { claimable: _claimable, ...rest } = job;
  const { heldKeys, freeKeys } = busWorkFeedJobHold(job, held, coverage);
  const heldState = job.claimKeys.length === 0 ? false
    : heldKeys !== null && heldKeys.length > 0 ? true
    : coverage === 'unknown' || coverage === 'truncated' ? null
    : false;
  return { ...rest, held: heldState, heldKeys, freeKeys };
}

/**
 * The hold evidence behind one ok feed read, shared by the jobs and
 * announced sections — `busWorkFeedHoldIndex` over the read's claims join.
 * `unknown` means the coordination table could not be read; `truncated`
 * means shown holds are real but later ones are unseen.
 */
function feedHoldIndex(feed: Extract<BusWorkFeedReadResult, { status: 'ok' }>): {
  coverage: BusWorkMineHoldCoverage;
  heldByJob: ReadonlyMap<string, ReadonlySet<string>>;
} {
  return busWorkFeedHoldIndex(feed.claims);
}

function jobsSection(feed: BusWorkFeedReadResult, agent: string, root: string | undefined): BusWorkMineJobs {
  if (feed.status === 'refused') return { status: 'refused', reason: feed.reason, receipts: feed.receipts,
    ...(feed.receipt === undefined ? {} : { receipt: feed.receipt }) };
  if (feed.status !== 'ok') return { status: feed.status };
  const { coverage, heldByJob } = feedHoldIndex(feed);
  const open = feed.jobs
    .filter(job => BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const toMatch = busWorkFeedToMatcher(agent, { root });
  const ownerMatch = busWorkFeedOwnerMatcher(agent, { root });
  return {
    status: 'ok', holds: coverage, open: open.length, receipts: feed.receipts,
    truncated: open.length > WORK_MINE_JOBS_MAX,
    jobs: open.slice(0, WORK_MINE_JOBS_MAX).map(job =>
      busWorkMineJobAnnotation(job, heldByJob.get(job.id), coverage, toMatch(job.to), ownerMatch(job.owner))),
  };
}

/**
 * Feed statuses that end a job's board life for its announcer. `failed`
 * stays listed: only the announcer may move a job, and a failed job can
 * still be rescheduled or terminated — it is exactly the announcement that
 * needs the agent's next decision.
 */
const ANNOUNCED_DONE: ReadonlySet<BusWorkFeedJob['status']> = new Set(['done', 'terminated']);

/**
 * The outbound side of the jobs section: every feed job this agent announced
 * that has not reached `done` or `terminated`, newest update first. `jobs`
 * answers "what can I still claim"; this answers "what did I post and where
 * does it stand" — an announced job leaves the open set the moment a worker
 * claims it or its status moves past `queued`/`rescheduled`, yet only the
 * announcer may post its next status, so a live announcement is work the
 * agent still drives. Each item carries the same per-key hold coverage the
 * jobs section computes, so a job whose status says in progress but whose
 * declared keys have no live hold reads as such without a second read.
 * Matching reuses the jobs section's owner matcher, so an unresolvable ref
 * or unreadable registry keeps exact-label matching and never widens; a
 * non-ok feed reports its own state, never an empty list.
 */
function announcedSection(feed: BusWorkFeedReadResult, agent: string, root: string | undefined): BusWorkMineAnnounced {
  if (feed.status === 'refused') return { status: 'refused', reason: feed.reason, receipts: feed.receipts,
    ...(feed.receipt === undefined ? {} : { receipt: feed.receipt }) };
  if (feed.status !== 'ok') return { status: feed.status };
  const ownerMatch = busWorkFeedOwnerMatcher(agent, { root });
  const { coverage, heldByJob } = feedHoldIndex(feed);
  const live = feed.jobs
    .filter(job => !ANNOUNCED_DONE.has(job.status) && ownerMatch(job.owner))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { status: 'ok', matched: live.length,
    items: live.slice(0, WORK_MINE_ANNOUNCED_MAX)
      .map(job => busWorkMineAnnouncedAnnotation(job, heldByJob.get(job.id), coverage)),
    truncated: live.length > WORK_MINE_ANNOUNCED_MAX };
}

/**
 * The next page of mail addressed to the agent — the same matching, order and
 * owner-share receipt checks `agents bus inbox` applies, capped at the oldest
 * WORK_MINE_INBOX_MAX pending messages. The read asks for the matched total
 * too, so `matched` reports every pending row the same filters accept across
 * the whole retained store, not just the shown window. One extra row is read
 * past the cap so `truncated` is definitive: a full window proves mail remains
 * beyond `nextCursor`, a short one proves the scan reached the store's end.
 * When the window overflows the newest row is the one dropped, so `nextCursor`
 * resumes strictly before it and `agents bus inbox --after` redelivers nothing
 * shown and skips nothing pending.
 */
function inboxSection(agent: string, options: BusWorkMineOptions, nowMs: number): BusWorkMineInbox {
  const page = readAgentInbox(agent, { limit: WORK_MINE_INBOX_MAX + 1, matched: true },
    { root: options.root, now: () => nowMs });
  if (page.status !== 'ok') return { status: page.status, reason: page.reason };
  let shown = page.messages, nextCursor = page.nextCursor, truncated = false;
  if (page.messages.length > WORK_MINE_INBOX_MAX) {
    truncated = true;
    let newest = 0;
    for (let i = 1; i < page.messages.length; i += 1) {
      if (page.messages[i]!.cursor > page.messages[newest]!.cursor) newest = i;
    }
    shown = page.messages.filter((_, index) => index !== newest);
    nextCursor = Math.max(...shown.map(message => message.cursor));
  }
  return {
    status: 'ok', agent: page.agent, nextCursor, truncated,
    matched: page.matched ?? shown.length,
    messages: shown.map(message => ({
      cursor: message.cursor, id: message.envelope.id, ts: new Date(message.receivedAt).toISOString(),
      priority: message.priority, kind: message.kind, channel: message.channel,
      from: message.envelope.from, fromAgent: message.fromAgent,
      summary: mineField(busBodySummary(message.envelope.body) ?? busBodyFallbackSummary(message.envelope.body),
        WORK_MINE_SUMMARY_MAX),
      // Claimable work and worker-handoff mail keep the hold evidence the
      // inbox read already computed; other kinds carry no held field at all.
      ...(message.held === undefined ? {} : { held: message.held, holder: message.holder ?? null }),
      // Work-feed citations keep the same live job state the inbox read
      // resolved; other bodies carry no job field at all.
      ...(message.job === undefined ? {} : { job: message.job }),
    })),
  };
}

/**
 * Pending mail in the legacy `phm bus` mailbox store (`$ASHLR_HOME/bus-mailbox`)
 * addressed to any of the agent's labels — the records `phm bus inbox --to
 * <label>` reads and `phm bus ack` clears. The unified bus store never carried
 * them, so without this section a migrated agent cannot discover leftover
 * mail. Labels are the resolved identity's `agentLabels` set, or the literal
 * ref alone when no identity resolves — an unreadable registry or unregistered
 * ref never widens the match. An absent store is a verified-empty `ok`; an
 * unreadable one reports `unavailable`, never an empty list passed off as fact.
 */
function mailboxSection(agent: string, identity: AgentIdentity | undefined,
  options: BusWorkMineOptions, nowMs: number): BusWorkMineMailbox {
  const home = options.mailboxHome ?? (options.root === undefined ? undefined : dirname(options.root));
  let read: ReturnType<ReturnType<typeof createBusMailbox>['pendingFor']>;
  try {
    read = createBusMailbox(home, () => nowMs)
      .pendingFor(identity === undefined ? [agent] : agentLabels(identity), WORK_MINE_MAILBOX_MAX);
  } catch {
    return { status: 'unavailable', reason: 'mailbox-unreadable' };
  }
  return { status: 'ok', agent, matched: read.matched, truncated: read.matched > read.messages.length,
    messages: read.messages.map(row => ({
      id: row.envelope.id, to: row.envelope.to, from: row.envelope.from,
      priority: row.envelope.priority, ts: new Date(row.acceptedAt).toISOString(),
      expiresAt: new Date(row.acceptedAt + row.envelope.ttl).toISOString(),
      summary: mineField(busBodySummary(row.envelope.body) ?? busBodyFallbackSummary(row.envelope.body),
        WORK_MINE_SUMMARY_MAX),
    })) };
}

/** The claimable body kind an envelope carries: legacy `work` or protocol-v1 `task`. */
function claimableKind(body: unknown): 'work' | 'task' | null {
  if (!isClaimableWork(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.hasOwn(record, BUS_PROTOCOL_KEY) ? 'task' : 'work';
}

interface NextCandidate {
  cursor: number;
  receivedAt: number;
  priority: BusPriority;
  id: string;
  to: string;
  kind: 'work' | 'task';
  from: string;
  fromAgent: string | null;
  summary: string;
  expiresAt: number;
}

interface HandoffCandidate {
  cursor: number;
  receivedAt: number;
  priority: BusPriority;
  id: string;
  to: string;
  taskId: string;
  from: string;
  fromAgent: string | null;
  summary: string;
  expiresAt: number;
}

/** One bounded-walk failure shared by the `next` and `handoffs` sections — same store, same read. */
type PendingWorkScanFail = { status: 'unavailable' | 'retryable' | 'invalid'; reason: string };

/**
 * The pending work `fleet bus-next` and `fleet handoff-receive` would find for
 * this agent, from one bounded walk of the retained store: every live envelope
 * whose body is claimable work (`kind:'work'` or a protocol-v1 `task`) or a
 * receivable `worker-handoff`, and whose `to`/`from` pair satisfies the shared
 * `agentPendingAddressMatcher` rule `bus next` claims by — any label of the
 * resolved identity or a `group:<channel>:<topic>` address of a channel the
 * identity belongs to, minus the agent's own channel posts — ordered the way
 * `claimNextBusWork` claims — priority band, then cursor.
 * Each item reports its hold state against the same two stores the unified
 * inbox consults: a taken message-id claim row (live lease or completed) on
 * the exact receipt, or a live coordination row blocking `queue:<envelope
 * id>`. An unreadable claims or coordination store degrades `holds` to
 * `unknown` and every item's `held` to null — candidates are still listed
 * rather than hidden, matching the unified inbox's degraded rule. Read-only:
 * no claims, no mutations.
 */
function pendingWorkSections(agent: string, options: BusWorkMineOptions, nowMs: number,
  registry: AgentRegistry | undefined): { next: BusWorkMineNext; handoffs: BusWorkMineHandoffs } {
  const scanFail = (result: PendingWorkScanFail) => ({ next: result, handoffs: result });
  // "Addressed to this agent" is the shared pending-work rule `bus next`
  // claims by: any label of the resolved identity or a member channel's
  // `group:<name>:` address, minus the agent's own channel posts — never
  // widened on an unreadable registry or unresolvable ref.
  const pendingAddress = agentPendingAddressMatcher(agent, registry);
  const nextCandidates: NextCandidate[] = [];
  const handoffCandidates: HandoffCandidate[] = [];
  const sender = (from: string): string | null =>
    registry === undefined ? null : resolveAgent(registry, from)?.handle ?? null;
  const summaryOf = (body: unknown): string =>
    mineField(busBodySummary(body) ?? busBodyFallbackSummary(body), WORK_MINE_SUMMARY_MAX);
  let cursor = 0, finished = false;
  // The same bounded walk `bus next` and the unified inbox use: a short page
  // proves the retained store was scanned to its end, a stalled cursor or an
  // exhausted bound is retryable — never a silently truncated `matched`.
  for (let index = 0; index < WORK_MINE_NEXT_MAX_PAGES && !finished; index += 1) {
    const page = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: () => nowMs });
    if (page.status !== 'ok') {
      return scanFail({ status: page.status === 'retryable' ? 'retryable' : page.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' });
    }
    for (const row of page.messages) {
      const envelope = row.envelope;
      if (!pendingAddress(envelope.to, envelope.from)) continue;
      const kind = claimableKind(envelope.body);
      if (kind !== null) {
        nextCandidates.push({
          cursor: row.cursor, receivedAt: row.receivedAt, priority: envelope.priority,
          id: envelope.id, to: envelope.to, kind, from: envelope.from, fromAgent: sender(envelope.from),
          summary: summaryOf(envelope.body),
          // The reader decrements ttl to what remains; expiry is a real deadline.
          expiresAt: nowMs + envelope.ttl,
        });
        continue;
      }
      // Only bodies the handoff verbs themselves accept count as pending
      // assignments — the shared contract, never a looser local shape.
      if (!isWorkerHandoffBody(envelope.body)) continue;
      handoffCandidates.push({
        cursor: row.cursor, receivedAt: row.receivedAt, priority: envelope.priority,
        id: envelope.id, to: envelope.to, taskId: envelope.body.taskId, from: envelope.from,
        fromAgent: sender(envelope.from), summary: summaryOf(envelope.body),
        expiresAt: nowMs + envelope.ttl,
      });
    }
    if (page.messages.length < BUS_INBOX_MAX_READ) { finished = true; break; }
    if (page.nextCursor <= cursor) {
      return scanFail({ status: 'retryable', reason: 'Bus store cursor did not advance.' });
    }
    cursor = page.nextCursor;
  }
  if (!finished) {
    return scanFail({ status: 'retryable', reason: 'Bus store scan exceeded the bounded read.' });
  }

  const claimsRead = inspectBusWorkClaims(options.root);
  const coordination = listCoordination(options.root, nowMs);
  const holdsUnknown = claimsRead.source === 'unavailable' || coordination.source === 'unavailable';
  // Taken message-id rows keyed by the exact receipt triple; a completed row
  // stays taken, an expired lease does not — the unified inbox's rule.
  const messageClaims = new Map<string, string>();
  if (!holdsUnknown) {
    for (const row of claimsRead.claims) {
      if (row.completedAt !== null || row.leaseUntil > nowMs) {
        messageClaims.set(`${row.id}:${row.cursor}:${row.receivedAt}`, row.owner);
      }
    }
  }
  const liveCoordination = coordination.claims.filter(row => row.live);
  const heldFor = (candidate: { id: string; cursor: number; receivedAt: number }) => {
    if (holdsUnknown) return { held: null, holder: null };
    const messageOwner = messageClaims.get(`${candidate.id}:${candidate.cursor}:${candidate.receivedAt}`);
    const coordinationBlocker = liveCoordination.find(row => coordinationRowBlocks(row, `queue:${candidate.id}`));
    const held = messageOwner !== undefined || coordinationBlocker !== undefined;
    return { held, holder: held ? messageOwner ?? coordinationBlocker?.owner ?? null : null };
  };
  const claimOrder = (a: { priority: BusPriority; cursor: number }, b: { priority: BusPriority; cursor: number }) =>
    BUS_PRIORITIES.indexOf(a.priority) - BUS_PRIORITIES.indexOf(b.priority) || a.cursor - b.cursor;
  const holds: 'complete' | 'unknown' = holdsUnknown ? 'unknown' : 'complete';

  nextCandidates.sort(claimOrder);
  const next: BusWorkMineNext = {
    status: 'ok', holds, matched: nextCandidates.length,
    items: nextCandidates.slice(0, WORK_MINE_NEXT_MAX).map(candidate => {
      const { held, holder } = heldFor(candidate);
      return {
        cursor: candidate.cursor, id: candidate.id, to: candidate.to, priority: candidate.priority,
        ts: new Date(candidate.receivedAt).toISOString(),
        expiresAt: new Date(candidate.expiresAt).toISOString(),
        kind: candidate.kind, from: candidate.from, fromAgent: candidate.fromAgent,
        summary: candidate.summary, held, holder,
      };
    }),
    truncated: nextCandidates.length > WORK_MINE_NEXT_MAX,
  };

  handoffCandidates.sort(claimOrder);
  const handoffs: BusWorkMineHandoffs = {
    status: 'ok', holds, matched: handoffCandidates.length,
    items: handoffCandidates.slice(0, WORK_MINE_HANDOFFS_MAX).map(candidate => {
      const { held, holder } = heldFor(candidate);
      return {
        cursor: candidate.cursor, id: candidate.id, to: candidate.to, taskId: candidate.taskId,
        priority: candidate.priority,
        ts: new Date(candidate.receivedAt).toISOString(),
        expiresAt: new Date(candidate.expiresAt).toISOString(),
        from: candidate.from, fromAgent: candidate.fromAgent,
        summary: candidate.summary, held, holder,
      };
    }),
    truncated: handoffCandidates.length > WORK_MINE_HANDOFFS_MAX,
  };
  return { next, handoffs };
}

/**
 * The identity scope both conversation sections share, built once per read:
 * `isSelf` names the agent under any of its labels (with the literal-label
 * fallback when no identity resolves — matching never widens on unknown
 * state), `denotes` reports whether a routing name is the agent — its own
 * labels, a name resolving to its identity, or a `group:<channel>:<topic>`
 * address of a channel it belongs to — and `agentOf` resolves a projection
 * name to a registered handle or null.
 */
interface ConversationScope {
  isSelf: (name: string) => boolean;
  denotes: (name: string) => boolean;
  agentOf: (name: string) => string | null;
}

function conversationScope(agent: string, registry: AgentRegistry | undefined,
  identity: AgentIdentity | undefined): ConversationScope {
  const selfNames = new Set(identity === undefined ? [] : agentLabels(identity).map(agentName));
  const channelNames = new Set(registry === undefined || identity === undefined ? [] :
    registry.channels.filter(channel => channel.members.includes(identity.handle)).map(channel => channel.name));
  return {
    isSelf: (name) => identity === undefined
      ? name === agentName(agent)
      : selfNames.has(name) || (registry !== undefined && resolveAgent(registry, name)?.id === identity.id),
    denotes: (name) => {
      if (identity === undefined) return name === agentName(agent);
      if (selfNames.has(name)) return true;
      if (name.startsWith('group:')) {
        const rest = name.slice('group:'.length), sep = rest.indexOf(':');
        return sep > 0 && channelNames.has(rest.slice(0, sep));
      }
      return registry !== undefined && resolveAgent(registry, name)?.id === identity.id;
    },
    agentOf: (name) => registry === undefined ? null : resolveAgent(registry, name)?.handle ?? null,
  };
}

/**
 * The conversation threads whose latest message still wants this agent's
 * answer — the same thread state `agents conversations --waiting-only`
 * computes, narrowed to waits the agent (or a channel it belongs to) owes.
 * `waiting.on` is the conversation projection's recipient name with routing
 * prefixes already stripped, so matching goes through the same identity
 * labels and channel membership the other sections use, with the
 * literal-label fallback when no identity resolves — matching never widens
 * on unknown state. A thread whose waiting message the agent itself sent
 * never counts: you cannot owe yourself a reply. The section reads the one
 * shared conversations projection, so an unreadable store reports
 * `unavailable` and a missing one is a verified-empty `ok`, and `skipped`
 * keeps the damaged-row count honest.
 */
function threadsSection(conversations: AgentConversations, scope: ConversationScope): BusWorkMineThreads {
  const source = conversations.source;
  if (source === 'unavailable' || conversations.conversations === null) {
    return { status: 'unavailable', reason: 'Bus store is not readable.' };
  }
  const matched = conversations.conversations.filter(thread => thread.waiting !== null &&
    scope.denotes(thread.waiting.on) && !scope.isSelf(thread.messages[thread.messages.length - 1]!.from));
  return { status: 'ok', source, matched: matched.length,
    items: matched.slice(0, WORK_MINE_THREADS_MAX).map(thread => {
      const last = thread.messages[thread.messages.length - 1]!;
      const waiting = thread.waiting!;
      return {
        id: thread.id, messageId: last.id, kind: last.kind === 'handoff' ? 'handoff' : 'ask',
        waitingOn: waiting.on, waitingMs: waiting.ms, lastAt: thread.lastAt,
        messageCount: thread.messageCount, from: last.from,
        fromAgent: scope.agentOf(last.from),
        subject: mineField(thread.subject, WORK_MINE_SUMMARY_MAX),
      };
    }),
    truncated: matched.length > WORK_MINE_THREADS_MAX, skipped: conversations.skipped };
}

/**
 * The outbound mirror of `threads`: conversation threads whose latest
 * message the agent itself sent and which still wait on the recipient's
 * reply — asks and handoffs the agent asked and nobody has answered yet, so
 * "is my question still outstanding?" is answered by the same digest instead
 * of a second `agents conversations` read and a mental filter. The wait is
 * the projection's own: `waiting.on` names the last message's recipient,
 * and a thread only counts when that recipient is not the agent — you cannot
 * wait on yourself. A reply, a done or blocked state, or the wait's TTL
 * expiring drops the thread exactly the way `agents conversations` reports
 * it. Same shared read, same caps and honesty rules as `threads`; the two
 * sections are mutually exclusive on every thread (one needs the agent's
 * label off the waiting message, the other on it).
 */
function awaitingSection(conversations: AgentConversations, scope: ConversationScope): BusWorkMineAwaiting {
  const source = conversations.source;
  if (source === 'unavailable' || conversations.conversations === null) {
    return { status: 'unavailable', reason: 'Bus store is not readable.' };
  }
  const matched = conversations.conversations.filter(thread => thread.waiting !== null &&
    scope.isSelf(thread.messages[thread.messages.length - 1]!.from) && !scope.isSelf(thread.waiting.on));
  return { status: 'ok', source, matched: matched.length,
    items: matched.slice(0, WORK_MINE_THREADS_MAX).map(thread => {
      const last = thread.messages[thread.messages.length - 1]!;
      const waiting = thread.waiting!;
      return {
        id: thread.id, messageId: last.id, kind: last.kind === 'handoff' ? 'handoff' : 'ask',
        waitingOn: waiting.on, waitingOnAgent: scope.agentOf(waiting.on),
        waitingMs: waiting.ms, lastAt: thread.lastAt,
        messageCount: thread.messageCount, from: last.from,
        fromAgent: scope.agentOf(last.from),
        subject: mineField(thread.subject, WORK_MINE_SUMMARY_MAX),
      };
    }),
    truncated: matched.length > WORK_MINE_THREADS_MAX, skipped: conversations.skipped };
}

/**
 * The blocked mirror of `threads`/`awaiting`: conversation threads the shared
 * projection reports `state:'blocked'` — a blocker or failed report nothing
 * has answered — that the agent is a party to under any of its labels or a
 * `group:<channel>:<topic>` address of a channel it belongs to, the same
 * membership rule the other sections apply. A blocked thread has no
 * `waiting.on` to match, so participation is any participant name that
 * denotes the agent — a block the agent reported itself still shows, because
 * the thread stays pending until a newer message moves it out of the state.
 * Longest-standing block first; same caps, ordering honesty and
 * unreadable-store rule as the other thread sections.
 */
function blockedSection(conversations: AgentConversations, scope: ConversationScope, nowMs: number): BusWorkMineBlocked {
  const source = conversations.source;
  if (source === 'unavailable' || conversations.conversations === null) {
    return { status: 'unavailable', reason: 'Bus store is not readable.' };
  }
  const matched = conversations.conversations
    .filter(thread => thread.state === 'blocked' &&
      thread.participants.some(participant => scope.denotes(participant.name)))
    .map(thread => ({ thread, blockedMs: Math.max(0, nowMs - Date.parse(thread.lastAt)) }))
    .sort((a, b) => b.blockedMs - a.blockedMs ||
      (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0));
  return { status: 'ok', source, matched: matched.length,
    items: matched.slice(0, WORK_MINE_BLOCKED_MAX).map(({ thread, blockedMs }) => {
      const last = thread.messages[thread.messages.length - 1]!;
      return {
        id: thread.id, messageId: last.id, kind: last.kind,
        from: last.from, fromAgent: scope.agentOf(last.from), to: last.to,
        lastAt: thread.lastAt, blockedMs, messageCount: thread.messageCount,
        subject: mineField(thread.subject, WORK_MINE_SUMMARY_MAX),
      };
    }),
    truncated: matched.length > WORK_MINE_BLOCKED_MAX, skipped: conversations.skipped };
}

/**
 * Compose the reads one agent otherwise runs separately — `claim list
 * --owner`, `work feed`, the `bus next` and `handoff-receive` walks, `wakes`
 * and `inbox` — into one snapshot. The claims
 * join names the announced jobs each held claim's keys block, from the same
 * feed read the jobs section annotates, so the two views cannot disagree. A
 * non-ok feed leaves `jobs` absent on claims and reports its own state in the
 * jobs section; non-ok claims, next, handoffs, wakes or inbox reads report
 * their own state rather than zero or an empty list. `threads`, `awaiting`
 * and `blocked` share the one conversations read — unfiltered, so waits the
 * agent owes, waits the agent is owed and blocked threads it is a party to
 * all narrow the same projection at the frozen instant.
 */
export function readBusWorkMine(agent: string, options: BusWorkMineOptions = {}): BusWorkMineResult {
  if (!AGENT_REF.test(agent)) return { status: 'invalid', reason: 'invalid-agent' };
  const nowMs = (options.now ?? Date.now)();
  const asOf = new Date(nowMs).toISOString();

  const read = readAgentRegistry({ root: options.root });
  const registry = read.status === 'ok' ? read.registry : undefined;
  const identity = registry === undefined ? undefined : resolveAgent(registry, agent);
  const who: BusWorkMineAgent = { ref: agent, handle: identity?.handle ?? null,
    identity: identity?.id ?? null, registry: read.status === 'ok' ? read.source : 'unavailable' };

  const claimsRead = listBusClaims({ root: options.root, owner: agent, now: nowMs });
  const claims: BusWorkMineClaims = claimsRead.status !== 'ok' ? { status: 'unavailable' }
    : { status: 'ok', source: claimsRead.source, claims: claimsRead.claims,
        owner: claimsRead.owner ?? { ref: agent, identity: null, registry: who.registry } };

  const feed = readBusWorkFeed({ root: options.root, now: () => nowMs, claims: true });
  const jobs = jobsSection(feed, agent, options.root);
  const announced = announcedSection(feed, agent, options.root);
  const { next, handoffs } = pendingWorkSections(agent, options, nowMs, registry);
  // One unfiltered conversations read backs all three thread views: waits the
  // agent owes, its own unanswered asks and blocked threads it is a party to
  // share the same projection and frozen instant.
  const conversations = readAgentConversations({}, { root: options.root, now: () => nowMs });
  const scope = conversationScope(agent, registry, identity);
  const threads = threadsSection(conversations, scope);
  const awaiting = awaitingSection(conversations, scope);
  const blocked = blockedSection(conversations, scope, nowMs);

  if (claims.status === 'ok' && feed.status === 'ok') {
    for (const claim of claims.claims) {
      claim.jobs = feed.jobs
        .filter(job => job.claimKeys.some(key => coordinationRowBlocks(claim, key)))
        .map(job => ({ id: job.id, owner: job.owner, status: job.status, title: job.title,
          ...(job.detail === undefined ? {} : { detail: job.detail }) }));
    }
  }

  const page = readAgentWakes(agent, undefined,
    { root: options.root, runsRoot: options.runsRoot, now: () => nowMs });
  const wakes: BusWorkMineWakes = page.status === 'ok'
    ? { status: 'ok', agent: page.agent, scope: page.scope, matched: page.matched,
        truncated: page.truncated || page.matched > WORK_MINE_WAKES_MAX,
        wakes: page.wakes.slice(-WORK_MINE_WAKES_MAX) }
    : { status: page.status, reason: page.reason };

  const inbox = inboxSection(agent, options, nowMs);
  const mailbox = mailboxSection(agent, identity, options, nowMs);

  return { status: 'ok', agent: who, asOf, claims, jobs, announced, next, handoffs, threads, awaiting, blocked, wakes, inbox, mailbox };
}

/** Scrubbed, single-line, clipped display field; '' when nothing readable remains. */
function mineField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human lines for `agents bus work mine`; JSON carries the full projection. */
export function formatBusWorkMine(result: BusWorkMineResult): string[] {
  if (result.status !== 'ok') return [`${result.status}: ${result.reason}`];
  const lines: string[] = [];
  const who = result.agent;
  lines.push(`agent=${who.handle ?? who.ref} ref=${who.ref} identity=${who.identity ?? '-'} ` +
    `registry=${who.registry} as-of=${result.asOf}`);

  const claims = result.claims;
  if (claims.status !== 'ok') {
    lines.push('claims=unknown');
  } else {
    lines.push(`claims=${claims.claims.length} source=${claims.source} ` +
      `owner-match=${claims.owner.identity ?? 'label'} registry=${claims.owner.registry}`);
    for (const row of claims.claims) {
      const blocked = row.jobs === undefined ? 'unknown'
        : row.jobs.length === 0 ? 'none'
        : row.jobs.map(job => `${job.id}(${job.status})`).join(',');
      lines.push(`  ${row.key} owner=${row.owner} origin=${row.origin} ` +
        `until=${new Date(row.leaseUntil).toISOString()} source=${row.sourceId} jobs=${blocked}`);
    }
  }

  const jobs = result.jobs;
  if (jobs.status !== 'ok') {
    lines.push(`jobs=unknown feed=${jobs.status}${jobs.status === 'refused'
      ? `:${jobs.reason}${jobs.receipt === undefined ? '' : ` receipt=${jobs.receipt.id}`}` : ''}`);
  } else {
    lines.push(`jobs=${jobs.open} shown=${jobs.jobs.length}${jobs.truncated ? '+truncated' : ''} ` +
      `holds=${jobs.holds} receipts=${jobs.receipts}`);
    for (const job of jobs.jobs) {
      const title = mineField(job.title, 80);
      const detail = job.detail === undefined ? '' : mineField(job.detail, 120);
      const keys = (list: string[] | null): string => list === null ? '-' : mineField(list.join(','), 400);
      const claimable = job.claimable === null ? 'unknown' : job.claimable ? 'yes' : 'no';
      lines.push(`  ${job.id} ${job.status}${title === '' ? '' : ` "${title}"`}` +
        `${detail === '' ? '' : ` detail="${detail}"`} ` +
        `claimable=${claimable} addressed=${job.addressed} announced=${job.announced} owner=${job.owner} repo=${job.repo} ` +
        `free=${keys(job.freeKeys)} held=${keys(job.heldKeys)} post=${job.postId}` +
        `${job.statusId === null ? '' : ` status=${job.statusId}`}`);
    }
  }

  const announced = result.announced;
  if (announced.status !== 'ok') {
    lines.push(`announced=unknown ${announced.status}` +
      `${announced.status === 'refused'
        ? `:${announced.reason}${announced.receipt === undefined ? '' : ` receipt=${announced.receipt.id}`}` : ''}`);
  } else {
    lines.push(`announced=${announced.matched} shown=${announced.items.length}` +
      `${announced.truncated ? '+truncated' : ''}`);
    for (const job of announced.items) {
      const title = mineField(job.title, 80);
      const detail = job.detail === undefined ? '' : mineField(job.detail, 120);
      const keys = job.claimKeys.length === 0 ? 'none' : mineField(job.claimKeys.join(','), 400);
      const held = job.held === null ? 'unknown' : job.held ? 'yes' : 'no';
      const keyList = (list: string[] | null): string => list === null ? '-' : mineField(list.join(','), 400);
      lines.push(`  ${job.id} ${job.status}${title === '' ? '' : ` "${title}"`}` +
        `${detail === '' ? '' : ` detail="${detail}"`} ` +
        `owner=${job.owner} to=${job.to} provider=${job.provider} repo=${job.repo} keys=${keys} ` +
        `held=${held} free=${keyList(job.freeKeys)} heldkeys=${keyList(job.heldKeys)} ` +
        `updated=${new Date(job.updatedAt).toISOString()} post=${job.postId}` +
        `${job.statusId === null ? '' : ` status=${job.statusId}`}`);
    }
  }

  const next = result.next;
  if (next.status !== 'ok') {
    lines.push(`next=unknown ${next.status}`);
  } else {
    lines.push(`next=${next.matched} shown=${next.items.length}${next.truncated ? '+truncated' : ''} ` +
      `holds=${next.holds}`);
    for (const item of next.items) {
      const from = item.fromAgent ? `agent:${item.fromAgent}` : `label ${item.from}`;
      const held = item.held === null ? 'unknown' : item.held ? 'yes' : 'no';
      const holder = item.holder === null ? '' : ` holder=${item.holder}`;
      lines.push(`  [${item.priority} ${item.kind} id=${item.id} from ${from} to ${item.to}] ${item.summary} ` +
        `held=${held}${holder} expires=${item.expiresAt}`);
    }
  }

  const handoffs = result.handoffs;
  if (handoffs.status !== 'ok') {
    lines.push(`handoffs=unknown ${handoffs.status}`);
  } else {
    lines.push(`handoffs=${handoffs.matched} shown=${handoffs.items.length}${handoffs.truncated ? '+truncated' : ''} ` +
      `holds=${handoffs.holds}`);
    for (const item of handoffs.items) {
      const from = item.fromAgent ? `agent:${item.fromAgent}` : `label ${item.from}`;
      const held = item.held === null ? 'unknown' : item.held ? 'yes' : 'no';
      const holder = item.holder === null ? '' : ` holder=${item.holder}`;
      lines.push(`  [${item.priority} handoff id=${item.id} task=${item.taskId} from ${from} to ${item.to}] ${item.summary} ` +
        `held=${held}${holder} expires=${item.expiresAt}`);
    }
  }

  const threads = result.threads;
  if (threads.status !== 'ok') {
    lines.push(`threads=unknown ${threads.status}`);
  } else {
    lines.push(`threads=${threads.matched} shown=${threads.items.length}${threads.truncated ? '+truncated' : ''}`);
    for (const item of threads.items) {
      const from = item.fromAgent ? `agent:${item.fromAgent}` : `label ${item.from}`;
      lines.push(`  [${item.kind} id=${item.messageId} thread=${item.id} from ${from} to ${item.waitingOn}] ` +
        `${item.subject} waiting=${plainAge(item.waitingMs)} messages=${item.messageCount}`);
    }
  }

  const awaiting = result.awaiting;
  if (awaiting.status !== 'ok') {
    lines.push(`awaiting=unknown ${awaiting.status}`);
  } else {
    lines.push(`awaiting=${awaiting.matched} shown=${awaiting.items.length}${awaiting.truncated ? '+truncated' : ''}`);
    for (const item of awaiting.items) {
      const on = item.waitingOnAgent ? `agent:${item.waitingOnAgent}` : `label ${item.waitingOn}`;
      lines.push(`  [${item.kind} id=${item.messageId} thread=${item.id} from ${item.from} to ${on}] ` +
        `${item.subject} waiting=${plainAge(item.waitingMs)} messages=${item.messageCount}`);
    }
  }

  const blocked = result.blocked;
  if (blocked.status !== 'ok') {
    lines.push(`blocked=unknown ${blocked.status}`);
  } else {
    lines.push(`blocked=${blocked.matched} shown=${blocked.items.length}${blocked.truncated ? '+truncated' : ''}`);
    for (const item of blocked.items) {
      const from = item.fromAgent ? `agent:${item.fromAgent}` : `label ${item.from}`;
      lines.push(`  [${item.kind} id=${item.messageId} thread=${item.id} from ${from} to ${item.to}] ` +
        `${item.subject} blocked=${plainAge(item.blockedMs)} messages=${item.messageCount}`);
    }
  }

  const wakes = result.wakes;
  if (wakes.status !== 'ok') {
    lines.push(`wakes=unknown ${wakes.status}`);
  } else {
    lines.push(`wakes=${wakes.matched} shown=${wakes.wakes.length}` +
      `${wakes.scope === 'label' ? ' scope=label' : ''}${wakes.truncated ? '+truncated' : ''}`);
    for (const wake of wakes.wakes) {
      lines.push(`  ${new Date(wake.at).toISOString()} ${wake.id} ${wake.from} -> ${wake.to}` +
        agentWakeClaimHolderSuffix(wake));
    }
  }

  const inbox = result.inbox;
  if (inbox.status !== 'ok') {
    lines.push(`inbox=unknown ${inbox.status}`);
  } else {
    lines.push(`inbox=${inbox.matched} shown=${inbox.messages.length}${inbox.truncated ? '+truncated' : ''} ` +
      `nextCursor=${inbox.nextCursor}`);
    for (const message of inbox.messages) {
      const where = message.kind === 'channel' ? `#${message.channel}` : message.kind;
      const from = message.fromAgent ? `agent:${message.fromAgent}` : `label ${message.from}`;
      const held = message.held === undefined ? '' :
        ` held=${message.held === null ? 'unknown' : message.held ? 'yes' : 'no'}${message.holder ? ` holder=${message.holder}` : ''}`;
      const job = message.job === undefined ? '' : ` ${busInboxJobMarker(message.job)}`;
      lines.push(`  [${message.priority} ${where} id=${message.id} from ${from}${held}${job}] ${message.summary}`);
    }
  }

  const mailbox = result.mailbox;
  if (mailbox.status !== 'ok') {
    lines.push(`mailbox=unknown ${mailbox.status}`);
  } else {
    lines.push(`mailbox=${mailbox.matched} shown=${mailbox.messages.length}${mailbox.truncated ? '+truncated' : ''}`);
    for (const message of mailbox.messages) {
      lines.push(`  [${message.priority} legacy id=${message.id} from ${message.from} to ${message.to}] ` +
        `${message.summary} expires=${message.expiresAt}`);
    }
  }
  return lines;
}
