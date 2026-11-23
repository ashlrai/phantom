/**
 * `agents bus work mine`: one read answering "what is pending for this agent" —
 * the live claims it holds under any of its labels — message-id leases
 * resolved to the live envelope they cover — the open work-feed jobs it
 * could still claim, the work-feed jobs it announced that have not finished —
 * each with the live claim coverage of its declared keys and the shown hold
 * rows naming who holds each blocked key and until when —
 * the claimable work envelopes and worker-handoff
 * assignments addressed to it — under any of its labels or to a channel it
 * belongs to — in `bus next` order, the conversation threads waiting on its
 * answer, the conversation threads it is waiting on, the blocked conversation
 * threads it is a party to, the wake hints addressed to
 * it, the next page of mail in its inbox, the pending mail the legacy
 * `phm bus` mailbox still holds for any of its labels, the shared task
 * board's pending digest (`phm bus board pending`) under the same labels and —
 * on the async `readBusWorkMineWithSeats` read — the bot-seat handoff work
 * (`planSeatHandoffs`, the read `phm bots handoffs` and the unified inbox's
 * seats source serve) the agent's seats still hold.
 * Each section reads the same
 * projection the dedicated verb
 * serves and keeps its honesty rules: an unreadable store, coordination table,
 * registry or wake queue narrows the match or reports unknown, never an empty
 * list passed off as fact. Routing labels are not authentication; claims
 * coordinate scope and grant no execution authority. Read-only: no writes, no
 * claims, no dispatch — the board section reads an existing board only and
 * never creates its state directory or lock file.
 */
import { coordinationRowBlocks, listCoordination } from './claim-store.js';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { busClaimJobRef, listBusClaims, type BusClaimsListClaim, type BusClaimsOwnerMatch } from './bus-claims.js';
import { agentLabels, agentPendingAddressMatcher, readAgentRegistry, resolveAgent, type AgentIdentity, type AgentRegistry } from './bus-identity.js';
import { parseClaimKey } from './bus-v2-schema.js';
import type { AgentMessageKind } from '../fleet/agent-messages.js';
import { conversationScope, readAgentConversations, type AgentConversations, type ConversationScope } from '../fleet/agent-conversations.js';
import { plainAge } from '../fleet/agent-conversation-model.js';
import { BUS_FEED_OPEN_STATUSES, busWorkFeedHoldIndex, busWorkFeedJobHold, busWorkFeedJobSearchText, busWorkFeedOwnerMatcher, busWorkFeedPendingToMatcher,
  busWorkJobDispatch, busWorkJobResultSuffix, readBusWorkFeed, type BusWorkFeedHold, type BusWorkFeedHoldCoverage, type BusWorkFeedJob,
  type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { agentWakeClaimHolderSuffix, agentWakeMessageSuffix, busBodyFallbackSummary, busBodyJobIds, busBodyJobId, busBodyJobMatch,
  busBodySummary, busInboxJobMarker, busReadContains, busReadContainsMatch, jobAnnotationFromFeed, readAgentInbox, readAgentWakes,
  type AgentWakeRow, type BusEnvelopeLookupJob, type InboxKind } from './bus-unified.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { BUS_PROTOCOL_KEY, BUS_PRIORITIES, isClaimableWork,
  type BusPriority } from '../fleet/bus-envelope.js';
import { inspectBusWorkClaims, type BusWorkClaimView } from '../fleet/bus-work-claims.js';
import { busReplyCitations, handoffAnswerScope, isWorkerHandoffBody, workerHandoffAnswered, type BusReplyCitation } from '../fleet/handoff-body.js';
import { createBusMailbox, type BusMailboxPendingMessage } from '../fleet/bus-mailbox.js';
import { ashlrHome } from '../cloud/store.js';
import { loadConfigReadOnlyStrict } from '../config.js';
import { BusBoard, busBoardStoragePaths, type BusBoardPendingThread, type BusBoardTaskHold } from '../fleet/bus-board.js';
import { busBoardDeliveryText } from '../fleet/bus-delivery.js';
import { SharedStore } from '../fleet/shared-store.js';
import { neutralisePageText } from '../verse/browser-act-policy.js';
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import type { SeatOptions, SeatState } from '../bots/seats.js';

/** Overrides for the shared task board (`phm bus board pending`) the board
 * section reads; production derives the same paths the board CLI uses. */
export interface BusWorkMineBoardOptions {
  /** Board state dir; default `<dirname(root)>/bus` (`<ashlrHome>/bus` when `root` is unset). Must be absolute. */
  root?: string;
  /** Shared queue dir behind board task claims; default `<root>/bus-queue` (`<ashlrHome>/fleet/bus-queue` when `root` is unset). Must be absolute. */
  queueRoot?: string;
  /** Queue lease override; default the shared-queue config's `leaseMs`. */
  leaseMs?: number;
  /** Config the board's event-bus kill switch and shared-queue derivation read; default `loadConfigReadOnlyStrict()`. */
  config?: AshlrConfig;
}

export interface BusWorkMineOptions {
  /** Fleet root shared by the bus store, identity registry and coordination table. */
  root?: string;
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  /** ASHLR home owning the legacy `bus-mailbox` store (`$ASHLR_HOME/bus-mailbox`);
   * default `dirname(root)` when `root` is set — the fleet root's parent — else `ashlrHome()`. */
  mailboxHome?: string;
  /** Shared task board digest overrides; production derives the board CLI's paths. */
  board?: BusWorkMineBoardOptions;
  /** Seat-handoff plan read overrides for the `seats` section — consumed by
   * `readBusWorkMineSeats`/`readBusWorkMineWithSeats`, ignored by the
   * synchronous section reads. `fleetRoot`, `runs` and `now` default to this
   * digest's `root`, `runsRoot` and frozen clock so seat work joins the same
   * coordination table, identity registry and quota evidence the rest of the
   * digest reads. */
  seats?: SeatOptions;
  /** Keep only work that names this job id — the same citation rule
   * `agents bus inbox --job` applies (`busBodyJobMatch`: feed `jobId`
   * bodies, worker-handoff `taskId`s, `job:<id>` thread buckets) joined
   * with the feed-id and board `itemId` identity citations each section
   * already makes. Claimable work receipts name no job citation, so `next`
   * comes back empty under a job filter; every section's count stays the
   * filtered total, never the unfiltered one. */
  job?: string;
  /** Keep only pending items whose displayed descriptive text carries this
   * search string — the same case-insensitive substring rule every other
   * bus read's `--contains` applies, matched over each section's scrubbed
   * one-line display text (feed job title/detail/dispatch, body and thread
   * summaries, board post text and titles, claim-blocked job titles and
   * leased-message summaries, seat handoff work refs) and never over ids,
   * claim keys as keys, statuses or routing labels, which keep their own
   * filters. `channels` is registry context, not pending work, and stays
   * unfiltered like it does under `job`. Every section's count stays the
   * filtered total, never the unfiltered one. */
  contains?: string;
  /** Keep only pending items whose recorded appearance or last-activity
   * time reaches this epoch-ms cutoff — the same `--since` grammar and
   * inclusive `>=` match every bus read applies (the wakes read keeps its
   * own strictly-after boundary, which the section inherits), so "what is
   * new for me since my last check" is one filtered digest instead of a
   * full re-read. Each section
   * keys on the timestamp its own store keeps: claims on the lease's
   * `started`, feed jobs on `updatedAt`, pending work and mail on the
   * envelope receipt, mailbox rows on acceptance, conversation threads on
   * the latest message, wake hints on their queue time, board deliveries on
   * `createdAt`. An item
   * whose store keeps no timestamp — a claim with `started:null`, a board
   * task — never matches, the same "unknown stays out" rule the unified
   * inbox's `--since` applies; `channels` is registry context and stays
   * unfiltered like it does under `job`/`contains`, and `seats` stays
   * unfiltered because a pending handoff record's `createdAt` stamps the
   * plan read instant, not the held work's age — no per-record recency
   * exists to filter on. Every section's count
   * stays the filtered total, never the unfiltered one. */
  since?: number;
  /** Keep only pending items stamped with this exact P0..P3 band — the same
   * `--priority` match every other bus read applies — on the sections whose
   * items carry a wire band: `next` and `handoffs` keep envelopes of that
   * priority, `inbox` and `mailbox` keep mail of that band, `wakes` keeps
   * hints whose resolved referent reports that band (the wakes read's own
   * rule: `unresolved`/`unknown` referents never match), and `claims` keep
   * only message claims whose resolved leased envelope reports that band —
   * a claim with no resolved message (a scope-key claim, an unresolvable or
   * unreadable-message lease) names no provable band and never lists, the
   * same "unknown stays out" rule the job filter applies. `jobs`,
   * `announced`, the three thread sections, `board`, `channels` and `seats`
   * carry no per-item band in their projections and stay unfiltered, like
   * `channels` does under every filter. Every section's count stays the
   * filtered total, never the unfiltered one. */
  priority?: BusPriority;
  /** Injectable clock, frozen once so every section reads the same instant. */
  now?: () => number;
}

/** How completely the coordination holds behind the feed are known. */
export type BusWorkMineHoldCoverage = BusWorkFeedHoldCoverage;

/** One live coordination hold on a feed job's declared claim key, as the claims join shows it. */
export interface BusWorkMineJobHold {
  /** The job's declared claim key the hold blocks. */
  claimKey: string;
  /** Routing label of the claim's owner — a label, never authenticated identity. */
  owner: string;
  /** ISO-free epoch-ms lease expiry the coordination row reports. */
  leaseUntil: number;
  /** The claim class the hold came from — resource, message, team, board or queue. */
  origin: BusWorkFeedHold['origin'];
}

/** An open feed job plus its per-key hold state; a null field means unknown, never none. */
export interface BusWorkMineJob extends BusWorkFeedJob {
  /** True when the announcement is pending work addressed to this agent — the `work feed --to` rule: any label of its identity or a member `group:<channel>:<topic>` address, minus its own posts; false keeps exact-label misses honest. */
  addressed: boolean;
  /** True when the job's `owner` (announcer) label resolves to this agent's identity — the agent posted it and owns its status reports; false keeps exact-label misses honest. */
  announced: boolean;
  /** Declared keys with no shown live hold — null unless hold coverage is complete. */
  freeKeys: string[] | null;
  /** Declared keys with at least one shown live hold — null when the hold set itself is unknown. */
  heldKeys: string[] | null;
  /** true: a declared key is provably free; false: every declared key is provably held; null: coverage incomplete. */
  claimable: boolean | null;
  /** The shown live holds on this job's declared keys — who holds each blocked
   * key and until when, so "is this a live worker or a stale lease" answers
   * inside the digest instead of a `claim list --jobs` read. Null when hold
   * coverage is `unknown` (the table could not be read); under `truncated`
   * coverage the list is the shown lower bound, the same honesty `heldKeys`
   * keeps. Fencing tokens and lease source ids never leave the store. */
  holders: BusWorkMineJobHold[] | null;
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

/**
 * The live envelope an `origin:'message'` claim's `queue:<id>` key leases —
 * the same resolution `agents bus show` performs, shared across all of a
 * digest's message claims in one bounded store walk. The claim's journal row
 * pins the exact `(id, cursor, receivedAt)` receipt `bus next`/`bus-claim`
 * took, so a same-id receipt that replaced the pinned generation reports
 * `not-found` — the claim does not cover it — never the wrong message.
 */
export type BusWorkMineClaimMessage =
  | { status: 'resolved'; id: string; cursor: number;
      /** ISO receipt time of the pinned envelope. */
      ts: string;
      /** ISO expiry of the retained envelope the claim leased. */
      expiresAt: string;
      priority: BusPriority;
      /** Raw `to` routing label the envelope was addressed to. */
      to: string;
      /** Raw `from` routing label; `fromAgent` is its resolved handle or null. */
      from: string;
      fromAgent: string | null;
      /** Protocol body kind verbatim (`task`, `work`, `note`, ...); null when the body carries none. */
      bodyKind: string | null;
      /** Scrubbed, single-line body summary, clipped to the digest bound. */
      summary: string;
      /** Same live feed citation the inbox section resolves, present only on job-citing bodies. */
      job?: BusEnvelopeLookupJob;
      /** Every job id the leased body names under the `busBodyJobMatch`
       * citation rule — the feed `jobId`, a worker-handoff `taskId` or the
       * `job:<id>` thread bucket — sorted and deduplicated; the set a
       * `--job` claims filter matches against. Absent when the body names
       * no job. */
      jobIds?: string[];
      /** Journal pin state: `true` when a claims-journal row backs this exact
       * receipt triple, `false` when the journal read cleanly but holds no row
       * for this claim (coordination/journal drift — resolved by bare id),
       * `null` when the journal could not be read and pinning is unknown. */
      pinned: boolean | null }
  | { status: 'not-found'; id: string }
  | { status: 'unavailable' | 'retryable' | 'invalid'; id: string };

/** A live coordination claim plus, on `origin:'message'` rows, the message it leases. */
export type BusWorkMineClaim = BusClaimsListClaim & {
  /** Present only on `origin:'message'` claims — a `queue:<envelope-id>` lease
   * covers one retained message; every other origin covers a scope key, not mail. */
  message?: BusWorkMineClaimMessage;
};

export type BusWorkMineClaims =
  | { status: 'ok'; source: 'missing' | 'available'; claims: BusWorkMineClaim[];
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
  /** The shown live holds on this job's declared keys — who holds each blocked
   * key and until when, so the announcer can tell a live worker from a stale
   * lease without a `claim list --jobs` read. Null when hold coverage is
   * `unknown`; under `truncated` the list is the shown lower bound. */
  holders: BusWorkMineJobHold[] | null;
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
  | { status: 'unknown-agent' | 'unavailable' | 'invalid'; reason: string };

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
  /** Mail whose body declares a `jobId` (`work.post`, `work.status`,
   * `work.result` or `wake`) only: the live feed state of the job the body
   * cites — the same `BusEnvelopeLookupJob` `agents bus show` resolves,
   * read once per inbox page; absent on every other body kind. */
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

/** One unacknowledged shared task board delivery addressed to the agent. */
export interface BusWorkMineBoardDelivery {
  /** Delivery id — `phm bus thread ack <threadId> <id>` takes it verbatim. */
  id: string;
  threadId: string;
  /** Raw sender peer label. */
  sender: string;
  /** Raw recipient peer label — one of the agent's board labels. */
  recipient: string;
  /** ISO of the delivery record's creation time. */
  createdAt: string;
  /** Scrubbed, single-line post text, clipped to the digest bound. */
  summary: string;
}

/** One shared task board task on a thread the agent belongs to. */
export interface BusWorkMineBoardTask {
  id: string;
  threadId: string;
  /** Fleet queue item id the task coordinates. */
  itemId: string;
  /** Scrubbed, single-line task title, clipped to the digest bound. */
  title: string;
  /** Board state still records a claim ref; it may be live, expired, or superseded. */
  claimed: boolean;
  /** Observed fleet-queue hold state; 'unknown' whenever the queue cannot be read — never 'open' by default. */
  hold: BusBoardTaskHold;
  /** Live queue holder when `hold` is 'held': peer label and lease expiry only, never capability material. */
  owner: { peerId: string; leaseUntil: number } | null;
}

/**
 * The shared task board's pending digest (`phm bus board pending`) under
 * every routing label the agent answers to — the one pending-work store the
 * unified bus never carried. `peers` names the queried labels the board
 * actually knows (each a member of at least one thread), so an agent that
 * never joined the board reads verified-empty rather than mistaking "not a
 * peer" for "nothing pending". `threads` keeps the board's own joined-thread
 * rollups; deliveries and tasks carry the board's 50-item caps with `matched`
 * the true totals and `truncated` definitive.
 */
export type BusWorkMineBoard =
  | { status: 'ok'; peers: string[];
      /** 'unreadable' means the shared queue could not be inspected; every task `hold` is then 'unknown', never 'open'. */
      claims: 'readable' | 'unreadable';
      threads: BusBoardPendingThread[];
      deliveries: { matched: number; items: BusWorkMineBoardDelivery[]; truncated: boolean };
      tasks: { matched: number; items: BusWorkMineBoardTask[]; truncated: boolean } }
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

/** One pending seat handoff record — work a draining or idle-with-work seat still holds. */
export interface BusWorkMineSeatHandoff {
  /** Deterministic record id the `phm bots handoff --seat <id> --apply` journal dedupes on. */
  handoffId: string;
  /** The held work: a live coordination claim key or a fenced node job id. */
  work: { kind: 'node-job' | 'bus-claim'; ref: string };
  /** Branch the held claim row carried; null when it named none. */
  branch: string | null;
  /** Pull request a `pr:` claim key names; null otherwise. */
  pr: string | null;
}

/** One bot seat the agent denotes that still has pending (unjournaled) handoff work. */
export interface BusWorkMineSeat {
  /** Seat config id — the `--seat` handle the handoff verbs take. */
  seatId: string;
  /** The bus routing label the seat's claims and messages answer to. */
  participantId: string;
  /** Projected lifecycle state at the read instant — the same state `phm bots handoffs` reports. */
  state: SeatState['state'];
  /** Pending handoff records in plan order. */
  handoffs: BusWorkMineSeatHandoff[];
}

export type BusWorkMineSeats =
  | { status: 'ok'; matched: number; seats: BusWorkMineSeat[]; truncated: boolean }
  | { status: 'unavailable'; reason: string };

/** One registry channel the agent belongs to — membership says who may post, never presence or authority. */
export interface BusWorkMineChannel {
  name: string;
  /** Registered member count; the digest carries no member list — `agents bus channel list` does. */
  memberCount: number;
}

/**
 * The registry channels the agent belongs to — the routing context behind
 * every `group:<channel>:<topic>` item the other sections match. `source`
 * follows the registry read: `missing` is a verified-empty membership (the
 * agent provably belongs to no channel), `available` lists real memberships;
 * an unreadable registry is `unavailable`, never an empty list. An agent ref
 * that resolves to no identity has no handle and so provably belongs to no
 * channel — `channels` is then empty, not unknown.
 */
export type BusWorkMineChannels =
  | { status: 'ok'; source: 'missing' | 'available'; channels: BusWorkMineChannel[] }
  | { status: 'unavailable'; reason: string };

export type BusWorkMineResult =
  | { status: 'ok'; agent: BusWorkMineAgent; asOf: string;
      /** The job filter the read applied, echoed for JSON consumers; absent on an unfiltered read. */
      job?: string;
      /** The text filter the read applied, echoed for JSON consumers; absent on an unfiltered read. */
      contains?: string;
      /** The time filter the read applied, echoed as ISO for JSON consumers; absent on an unfiltered read. */
      since?: string;
      /** The band filter the read applied, echoed for JSON consumers; absent on an unfiltered read. */
      priority?: BusPriority;
      claims: BusWorkMineClaims; jobs: BusWorkMineJobs; announced: BusWorkMineAnnounced;
      next: BusWorkMineNext;
      handoffs: BusWorkMineHandoffs; threads: BusWorkMineThreads; awaiting: BusWorkMineAwaiting;
      blocked: BusWorkMineBlocked;
      wakes: BusWorkMineWakes; inbox: BusWorkMineInbox; mailbox: BusWorkMineMailbox;
      board: BusWorkMineBoard;
      channels: BusWorkMineChannels;
      /** Seat handoff digest — present only on the async
       * `readBusWorkMineWithSeats` read the CLI serves; the synchronous
       * `readBusWorkMine` leaves it absent rather than reporting a section
       * it never read. */
      seats?: BusWorkMineSeats }
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
  addressed: boolean, announced = false, holds?: readonly BusWorkFeedHold[],
): BusWorkMineJob {
  return { ...job, addressed, announced, ...busWorkFeedJobHold(job, held, coverage),
    holders: busWorkMineHolders(holds, coverage) };
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
  holds?: readonly BusWorkFeedHold[],
): BusWorkMineAnnouncedJob {
  // The feed annotates open jobs with `claimable`; announced items report the
  // `held` tri-state instead, so the feed-level field does not leak through.
  const { claimable: _claimable, ...rest } = job;
  const { heldKeys, freeKeys } = busWorkFeedJobHold(job, held, coverage);
  const heldState = job.claimKeys.length === 0 ? false
    : heldKeys !== null && heldKeys.length > 0 ? true
    : coverage === 'unknown' || coverage === 'truncated' ? null
    : false;
  return { ...rest, held: heldState, heldKeys, freeKeys,
    holders: busWorkMineHolders(holds, coverage) };
}

/**
 * The shown hold rows of one job as digest entries: claim key, owner label,
 * lease expiry and claim class — never the fencing token or lease source id.
 * `unknown` coverage means the coordination table could not be read, so the
 * list is null rather than an empty one; `truncated` keeps the shown rows as
 * the same lower bound `heldKeys` reports.
 */
function busWorkMineHolders(holds: readonly BusWorkFeedHold[] | undefined,
  coverage: BusWorkMineHoldCoverage): BusWorkMineJobHold[] | null {
  if (coverage === 'unknown') return null;
  return (holds ?? []).map(hold => ({ claimKey: hold.claimKey, owner: hold.owner,
    leaseUntil: hold.leaseUntil, origin: hold.origin }));
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
  holdsByJob: ReadonlyMap<string, readonly BusWorkFeedHold[]>;
} {
  return busWorkFeedHoldIndex(feed.claims);
}

function jobsSection(feed: BusWorkFeedReadResult, agent: string, root: string | undefined,
  jobId?: string, contains?: string, sinceMs?: number): BusWorkMineJobs {
  if (feed.status === 'refused') return { status: 'refused', reason: feed.reason, receipts: feed.receipts,
    ...(feed.receipt === undefined ? {} : { receipt: feed.receipt }) };
  if (feed.status !== 'ok') return { status: feed.status };
  const { coverage, heldByJob, holdsByJob } = feedHoldIndex(feed);
  const open = feed.jobs
    .filter(job => BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length > 0 &&
      (jobId === undefined || job.id === jobId) &&
      (contains === undefined || busWorkFeedJobSearchText(job).includes(contains)) &&
      (sinceMs === undefined || job.updatedAt >= sinceMs))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // `addressed` is the pending-work rule the feed `--to` filter and the
  // next/handoffs sections share: identity labels plus member `group:`
  // channel addresses, minus the agent's own posts — so a job `work feed
  // --to <agent>` lists never reads addressed:false here.
  const toMatch = busWorkFeedPendingToMatcher(agent, { root });
  const ownerMatch = busWorkFeedOwnerMatcher(agent, { root });
  return {
    status: 'ok', holds: coverage, open: open.length, receipts: feed.receipts,
    truncated: open.length > WORK_MINE_JOBS_MAX,
    jobs: open.slice(0, WORK_MINE_JOBS_MAX).map(job =>
      busWorkMineJobAnnotation(job, heldByJob.get(job.id), coverage, toMatch(job.to, job.owner),
        ownerMatch(job.owner), holdsByJob.get(job.id))),
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
function announcedSection(feed: BusWorkFeedReadResult, agent: string, root: string | undefined,
  jobId?: string, contains?: string, sinceMs?: number): BusWorkMineAnnounced {
  if (feed.status === 'refused') return { status: 'refused', reason: feed.reason, receipts: feed.receipts,
    ...(feed.receipt === undefined ? {} : { receipt: feed.receipt }) };
  if (feed.status !== 'ok') return { status: feed.status };
  const ownerMatch = busWorkFeedOwnerMatcher(agent, { root });
  const { coverage, heldByJob, holdsByJob } = feedHoldIndex(feed);
  const live = feed.jobs
    .filter(job => !ANNOUNCED_DONE.has(job.status) && ownerMatch(job.owner) &&
      (jobId === undefined || job.id === jobId) &&
      (contains === undefined || busWorkFeedJobSearchText(job).includes(contains)) &&
      (sinceMs === undefined || job.updatedAt >= sinceMs))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { status: 'ok', matched: live.length,
    items: live.slice(0, WORK_MINE_ANNOUNCED_MAX)
      .map(job => busWorkMineAnnouncedAnnotation(job, heldByJob.get(job.id), coverage,
        holdsByJob.get(job.id))),
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
function inboxSection(agent: string, options: BusWorkMineOptions, nowMs: number,
  contains?: string): BusWorkMineInbox {
  const page = readAgentInbox(agent, { limit: WORK_MINE_INBOX_MAX + 1, matched: true,
    ...(options.job === undefined ? {} : { job: options.job }),
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(contains === undefined ? {} : { contains }) },
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
  options: BusWorkMineOptions, nowMs: number, contains?: string): BusWorkMineMailbox {
  const home = options.mailboxHome ?? (options.root === undefined ? undefined : dirname(options.root));
  const job = options.job;
  const since = options.since;
  const priority = options.priority;
  const match = job === undefined && contains === undefined && since === undefined && priority === undefined ? undefined
    : (message: BusMailboxPendingMessage) =>
      (job === undefined || busBodyJobMatch(message.envelope.body, job)) &&
      (since === undefined || message.acceptedAt >= since) &&
      (priority === undefined || message.envelope.priority === priority) &&
      (contains === undefined || busReadContainsMatch(message.envelope.body, contains));
  let read: ReturnType<ReturnType<typeof createBusMailbox>['pendingFor']>;
  try {
    read = createBusMailbox(home, () => nowMs)
      .pendingFor(identity === undefined ? [agent] : agentLabels(identity), WORK_MINE_MAILBOX_MAX, match);
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

/** Scrubbed, single-line, clipped board text: the board's own invisible-byte neutralisation, then the digest clip. */
function boardText(text: string): string {
  return mineField(neutralisePageText(text), WORK_MINE_SUMMARY_MAX);
}

/**
 * The shared task board's pending digest (`phm bus board pending`) under
 * every routing label the agent answers to — the one pending-work store the
 * unified bus never carried, so without this section an agent on the board
 * still needs a separate `phm bus board pending --peer` read per label.
 * Labels are the resolved identity's `agentLabels` set, or the literal ref
 * alone when no identity resolves — the same narrowing the mailbox section
 * applies, so an unreadable registry or unregistered ref never widens the
 * match. Board paths derive exactly like the board CLI: `<dirname(root)>/bus`
 * and `<root>/bus-queue` (the fleet root's parent `bus/` dir and
 * `<ashlrHome>/fleet/bus-queue` when `root` is unset), or the configured
 * shared queue's `path` and `path/bus` under `fleet.sharedQueue.mode:
 * filesystem` with `trustedCoherentStorage`. A board that was never used —
 * no `state.json` — is a verified-empty `ok`: the read never creates the
 * directory or lock file the board's own transaction would leave, while the
 * queue read still reports claim-store readability honestly. An unreadable
 * board, a malformed shared-queue config, a relative path override or a
 * disabled event bus reports `unavailable`, never an empty list passed off
 * as fact.
 */
function boardSection(agent: string, identity: AgentIdentity | undefined,
  options: BusWorkMineOptions, nowMs: number, contains?: string): BusWorkMineBoard {
  const unavailable: BusWorkMineBoard = { status: 'unavailable', reason: 'board-unreadable' };
  if ((options.board?.root !== undefined && !isAbsolute(options.board.root)) ||
      (options.board?.queueRoot !== undefined && !isAbsolute(options.board.queueRoot))) {
    return unavailable;
  }
  let cfg: AshlrConfig;
  try {
    cfg = options.board?.config ?? loadConfigReadOnlyStrict();
  } catch {
    return unavailable;
  }
  const shared = cfg.fleet?.sharedQueue;
  const paths = busBoardStoragePaths(options.root ?? join(ashlrHome(), 'fleet'), cfg);
  if (paths.status !== 'ok') return unavailable;
  const boardRoot = options.board?.root ?? paths.boardRoot;
  const queueRoot = options.board?.queueRoot ?? paths.queueRoot;
  const fleet = new SharedStore(queueRoot, options.board?.leaseMs ?? shared?.leaseMs);
  if (!existsSync(join(boardRoot, 'state.json'))) {
    const index = fleet.readClaimIndex();
    return { status: 'ok', peers: [], claims: index.readable ? 'readable' : 'unreadable',
      threads: [], deliveries: { matched: 0, items: [], truncated: false },
      tasks: { matched: 0, items: [], truncated: false } };
  }
  try {
    const labels = identity === undefined ? [agent] : agentLabels(identity);
    const digest = new BusBoard({ root: boardRoot, fleet, cfg })
      .pendingFor(labels, nowMs, options.job, contains, options.since);
    return {
      status: 'ok', peers: digest.peers, claims: digest.claims, threads: digest.threads,
      deliveries: {
        matched: digest.deliveries.matched, truncated: digest.deliveries.truncated,
        items: digest.deliveries.items.map(delivery => ({
          id: delivery.id, threadId: delivery.threadId, sender: delivery.sender,
          recipient: delivery.recipient, createdAt: delivery.createdAt,
          summary: boardText(busBoardDeliveryText(delivery)),
        })),
      },
      tasks: {
        matched: digest.tasks.matched, truncated: digest.tasks.truncated,
        items: digest.tasks.items.map(task => ({
          id: task.id, threadId: task.threadId, itemId: task.itemId,
          title: boardText(task.content.text), claimed: task.claimed, hold: task.hold, owner: task.owner,
        })),
      },
    };
  } catch {
    return unavailable;
  }
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
  registry: AgentRegistry | undefined, contains?: string): { next: BusWorkMineNext; handoffs: BusWorkMineHandoffs } {
  const scanFail = (result: PendingWorkScanFail) => ({ next: result, handoffs: result });
  // "Addressed to this agent" is the shared pending-work rule `bus next`
  // claims by: any label of the resolved identity or a member channel's
  // `group:<name>:` address, minus the agent's own channel posts — never
  // widened on an unreadable registry or unresolvable ref.
  const pendingAddress = agentPendingAddressMatcher(agent, registry);
  // The answered check resolves reply labels through the same registry the
  // pending rule reads; an unreadable registry keeps literal-label matching.
  const answerScope = handoffAnswerScope(registry);
  const nextCandidates: NextCandidate[] = [];
  const handoffCandidates: HandoffCandidate[] = [];
  // Live reply citations collected across the same walk — a handoff's answer
  // routes back to its assigner, so it is gathered for every envelope, not
  // only the ones pendingAddress keeps.
  const replyCites: BusReplyCitation[] = [];
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
      replyCites.push(...busReplyCitations(envelope));
      if (!pendingAddress(envelope.to, envelope.from)) continue;
      // A job filter keeps only envelopes whose body names the job — the same
      // `busBodyJobMatch` citation rule `agents bus inbox --job` applies. It
      // runs after replyCites so a job-filtered handoff still sees its answer;
      // claimable work receipts name no job citation, so `next` comes back
      // empty under `--job` while handoffs keep their `taskId` hits. A
      // contains filter keeps only envelopes whose scrubbed one-line summary
      // carries the needle — the same `busReadContainsMatch` rule `agents
      // bus inbox --contains` applies — for both kinds alike. A since filter
      // keeps only receipts at or after the cutoff — the same
      // `receivedAt >= since` rule `agents bus inbox --since` applies — and
      // runs in the same place so a since-filtered handoff still sees its
      // answer in replyCites. A priority filter keeps only envelopes of that
      // band — the same exact P0..P3 match `agents bus inbox --priority`
      // applies — for both kinds alike.
      if (options.job !== undefined && !busBodyJobMatch(envelope.body, options.job)) continue;
      if (contains !== undefined && !busReadContainsMatch(envelope.body, contains)) continue;
      if (options.since !== undefined && row.receivedAt < options.since) continue;
      if (options.priority !== undefined && envelope.priority !== options.priority) continue;
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

  // A handoff the addressee already answered is not pending work: a live reply
  // routed recipient -> sender and citing the handoff id is the same durable
  // evidence the conversation projection credits when it marks the thread
  // answered — under any label of either identity, or from a member of the
  // addressed channel. Only live envelopes were scanned, matching that
  // window.
  const openHandoffs = handoffCandidates.filter(candidate => !workerHandoffAnswered(candidate, replyCites, answerScope));

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

  openHandoffs.sort(claimOrder);
  const handoffs: BusWorkMineHandoffs = {
    status: 'ok', holds, matched: openHandoffs.length,
    items: openHandoffs.slice(0, WORK_MINE_HANDOFFS_MAX).map(candidate => {
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
    truncated: openHandoffs.length > WORK_MINE_HANDOFFS_MAX,
  };
  return { next, handoffs };
}

/** The envelope id an `origin:'message'` claim's `queue:` key leases; undefined for any other key shape. */
function claimMessageId(key: string): string | undefined {
  const parsed = parseClaimKey(key);
  return parsed?.kind === 'queue' ? parsed.queue : undefined;
}

/** Every live receipt the bounded store walk serves, grouped by envelope id — the join behind claim-message resolution. */
function claimMessageReceipts(options: BusWorkMineOptions, nowMs: number):
  | { status: 'ok'; byId: Map<string, BusInboxReceipt[]> }
  | { status: 'unavailable' | 'retryable' | 'invalid' } {
  const byId = new Map<string, BusInboxReceipt[]>();
  let cursor = 0, finished = false;
  for (let index = 0; index < WORK_MINE_NEXT_MAX_PAGES && !finished; index += 1) {
    const page = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ,
      { root: options.root, now: () => nowMs, includeOriginalEnvelope: true });
    if (page.status !== 'ok') {
      return { status: page.status === 'retryable' ? 'retryable' : page.status === 'invalid' ? 'invalid' : 'unavailable' };
    }
    for (const row of page.messages) {
      const list = byId.get(row.envelope.id);
      if (list === undefined) byId.set(row.envelope.id, [row]);
      else list.push(row);
    }
    if (page.messages.length < BUS_INBOX_MAX_READ) { finished = true; break; }
    if (page.nextCursor <= cursor) return { status: 'retryable' };
    cursor = page.nextCursor;
  }
  if (!finished) return { status: 'retryable' };
  return { status: 'ok', byId };
}

/** The protocol body kind a claim-message resolution reports: top-level `kind`, else `protocol.kind` on bus-transport v1 bodies; null when neither is a string. */
function claimMessageBodyKind(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record['kind'] === 'string') return record['kind'];
  const proto = record['protocol'];
  if (proto !== null && typeof proto === 'object' && !Array.isArray(proto)) {
    const kind = (proto as Record<string, unknown>)['kind'];
    if (typeof kind === 'string') return kind;
  }
  return null;
}

/**
 * Resolve one message claim to the live envelope its journal row pinned — or,
 * when the journal cannot vouch for a triple, to the live receipt now
 * carrying the id with `pinned` marking the difference. `journal` is null
 * when the claims journal could not be read: resolution then falls back to
 * the bare id and reports `pinned: null` rather than hiding the claim's
 * message. When journal rows exist for the claim's owner label but none
 * matches a live receipt triple, the pinned message is gone and the claim
 * reports `not-found` — a same-id receipt that replaced it is a different
 * generation the claim does not cover. `feed` is the same read the jobs
 * section annotates, so a job citation resolves identically; `registry`
 * decorates `fromAgent` best-effort.
 */
function resolveClaimMessage(id: string, owner: string, journal: BusWorkClaimView[] | null,
  scan: ReturnType<typeof claimMessageReceipts>, nowMs: number,
  feed: BusWorkFeedReadResult, registry: AgentRegistry | undefined): BusWorkMineClaimMessage {
  if (scan.status !== 'ok') return { status: scan.status, id };
  const candidates = scan.byId.get(id) ?? [];
  // The unpinned fallbacks take the newest same-id receipt — the scan walks
  // cursor order, so the last entry is the latest generation the id carried.
  let receipt: BusInboxReceipt | undefined;
  let pinned: boolean | null;
  if (journal === null) {
    pinned = null;
    receipt = candidates.at(-1);
  } else {
    const rows = journal.filter(row => row.id === id && row.owner === owner);
    if (rows.length === 0) {
      pinned = false;
      receipt = candidates.at(-1);
    } else {
      // Live-lease rows pin first: the coordination claim is live, so the
      // journal row backing it should be too; completed and expired rows are
      // the drift fallback, tried in file order after them.
      const liveRows = rows.filter(row => row.completedAt === null && row.leaseUntil > nowMs);
      const settledRows = rows.filter(row => row.completedAt !== null || row.leaseUntil <= nowMs);
      for (const row of [...liveRows, ...settledRows]) {
        const found = candidates.find(candidate =>
          candidate.cursor === row.cursor && candidate.receivedAt === row.receivedAt);
        if (found !== undefined) { receipt = found; break; }
      }
      pinned = receipt !== undefined;
      if (receipt === undefined) return { status: 'not-found', id };
    }
  }
  if (receipt === undefined) return { status: 'not-found', id };
  const body = receipt.envelope.body;
  const jobId = busBodyJobId(body);
  // Every job the body names under the `busBodyJobMatch` citation rule —
  // the feed `jobId`/`taskId` citation plus the `job:<id>` thread bucket —
  // so a `--job` claims filter keys on the same set the inbox filter does.
  const jobIds = busBodyJobIds(body);
  // The page receipt's ttl is elapsed-adjusted; the original envelope keeps
  // the wire ttl, so expiry is receipt time plus the ttl the sender set.
  const ttl = receipt.originalEnvelope?.ttl ?? receipt.envelope.ttl;
  return { status: 'resolved', id, cursor: receipt.cursor,
    ts: new Date(receipt.receivedAt).toISOString(),
    expiresAt: new Date(receipt.receivedAt + ttl).toISOString(),
    priority: receipt.envelope.priority, to: receipt.envelope.to, from: receipt.envelope.from,
    fromAgent: registry === undefined ? null : resolveAgent(registry, receipt.envelope.from)?.handle ?? null,
    bodyKind: claimMessageBodyKind(body),
    summary: mineField(busBodySummary(body) ?? busBodyFallbackSummary(body), WORK_MINE_SUMMARY_MAX),
    ...(jobId === undefined ? {} : { job: jobAnnotationFromFeed(feed, jobId) }),
    ...(jobIds.length === 0 ? {} : { jobIds }),
    pinned };
}

/**
 * Annotate every `origin:'message'` claim with the live envelope its
 * `queue:<id>` key leases — the resolution `agents bus show` performs per
 * id, shared across all of a digest's message claims in one bounded store
 * walk and one journal read, so N claims never cost N scans. Claims of
 * every other origin cover scope keys, not mail, and stay unannotated. A
 * store or journal that cannot be read degrades only the annotation — the
 * claim rows themselves still list, the same rule `held` follows.
 */
function annotateClaimMessages(claims: BusWorkMineClaim[], options: BusWorkMineOptions,
  nowMs: number, feed: BusWorkFeedReadResult, registry: AgentRegistry | undefined): void {
  const targets = claims
    .map(claim => ({ claim, id: claim.origin === 'message' ? claimMessageId(claim.key) : undefined }))
    .filter((entry): entry is { claim: BusWorkMineClaim; id: string } => entry.id !== undefined);
  if (targets.length === 0) return;
  const journalRead = inspectBusWorkClaims(options.root);
  const journal = journalRead.source === 'unavailable' ? null : journalRead.claims;
  const scan = claimMessageReceipts(options, nowMs);
  for (const { claim, id } of targets) {
    claim.message = resolveClaimMessage(id, claim.owner, journal, scan, nowMs, feed, registry);
  }
}

/**
 * The conversation threads whose latest message still wants this agent's
 * answer — the same thread state `agents conversations --waiting`
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
 * The `--contains` verdict for one claim row, decided on the same displayed
 * evidence the digest renders: a blocked announced job's title or newest
 * status detail (`claim.jobs`, the feed projection `claim list --jobs`
 * shares — present only on an ok feed) or the resolved leased message's
 * scrubbed summary. The claim key, owner, origin and source id are
 * structured fields with their own filters, never search text; a claim
 * whose evidence cannot be read names no provable text and never matches.
 */
function claimContainsMatch(claim: BusWorkMineClaim, needle: string): boolean {
  const jobHit = claim.jobs?.some(ref =>
    scrubSecrets(`${ref.title} ${ref.detail ?? ''}`)
      .toLowerCase().replace(/\s+/g, ' ').includes(needle)) === true;
  if (jobHit) return true;
  return claim.message?.status === 'resolved' &&
    claim.message.summary.toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

/**
 * Compose the reads one agent otherwise runs separately — `claim list
 * --owner`, `work feed`, the `bus next` and `handoff-receive` walks, `wakes`
 * and `inbox` — into one snapshot. The claims
 * join names the announced jobs each held claim's keys block, from the same
 * feed read the jobs section annotates, so the two views cannot disagree;
 * `origin:'message'` claims additionally resolve their `queue:<id>` key to
 * the live envelope the message-id lease covers. A
 * non-ok feed leaves `jobs` absent on claims and reports its own state in the
 * jobs section; non-ok claims, next, handoffs, wakes or inbox reads report
 * their own state rather than zero or an empty list. `threads`, `awaiting`
 * and `blocked` share the one conversations read — narrowed to job-naming
 * threads when `options.job` is set, the same `job` query
 * `agents conversations --job` applies — so waits the agent owes, waits the
 * agent is owed and blocked threads it is a party to all narrow the same
 * projection at the frozen instant. `options.job` applies the
 * `busBodyJobMatch` citation rule every `--job` bus read shares — plus the
 * feed-id and board `itemId` identity joins — across every section: feed
 * jobs match by id, claims by declared-key overlap with an announced job
 * or a leased body's job citations, pending work and mail by body
 * citation, threads/wakes/inbox by their own job filters, and board work
 * by the job-carrying-thread rule `BusBoard.pendingFor` applies.
 * `options.contains` applies the text-search rule every `--contains` bus
 * read shares across the same sections: feed jobs and announced jobs match
 * the feed's own job search text, claims match a blocked job's title/detail
 * or a resolved leased message's summary, next/handoffs/mailbox match the
 * body summary, threads/awaiting/blocked match member-message subjects
 * through the shared conversations read, wakes match the resolved
 * referent's summary or citing status detail, inbox matches the inbox
 * read's own contains rule, the board matches delivery post text and
 * task/thread titles inside `BusBoard.pendingFor`, and seats match the
 * handoff's held-work ref and citations — the only text a seat record
 * carries. `options.since` applies the time rule every bus read's `--since`
 * shares across the same sections: claims match the lease's recorded
 * `started` (a null start never matches), feed jobs and announced jobs
 * match `updatedAt`, next/handoffs/inbox match the envelope receipt the
 * shared reads already filter on, mailbox matches acceptance, the three
 * thread sections and wakes inherit their own reads' `since`/`sinceAt`
 * rules on the latest activity, board deliveries match `createdAt` while
 * board tasks — which keep no timestamp — never match, and seats stay
 * unfiltered — a pending handoff record's `createdAt` stamps the plan
 * read instant, not the held work's age, so no per-record recency exists
 * to filter on; a since-filtered handoff still sees its
 * answer in the shared reply scan, and `channels` stays unfiltered under
 * all three filters. `options.priority` applies the band rule every bus
 * read's `--priority` shares across the sections whose items carry a wire
 * band: next/handoffs keep envelopes of that priority, inbox and mailbox
 * keep mail of that band, wakes keep hints whose resolved referent reports
 * it (unresolved or unknown referents never match), and claims keep only
 * message claims whose resolved leased envelope reports that band — a
 * claim naming no provable band never lists. Feed jobs, announced jobs,
 * the three thread sections, board rows, channels and seats carry no
 * per-item band and stay unfiltered. `channels` is registry context, not
 * pending work, and stays unfiltered under any filter. Counts
 * stay filtered totals; a section that cannot prove the relation reports
 * its own read state, never a padded match.
 */
export function readBusWorkMine(agent: string, options: BusWorkMineOptions = {}): BusWorkMineResult {
  if (!AGENT_REF.test(agent)) return { status: 'invalid', reason: 'invalid-agent' };
  // The same printable-label rule every `--job` read surface applies.
  if (options.job !== undefined && !AGENT_REF.test(options.job)) return { status: 'invalid', reason: 'invalid-job' };
  // The same bounded free-text rule every `--contains` bus read applies;
  // the normalized needle is what every section matches against.
  const contains = busReadContains(options.contains);
  if (contains === null) return { status: 'invalid', reason: 'invalid-contains' };
  // The same epoch-ms bound every bus read's `--since` validates: a safe
  // non-negative integer, parsed by the caller from the shared time grammar.
  if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < 0)) {
    return { status: 'invalid', reason: 'invalid-since' };
  }
  // The same P0..P3 band every bus read's `--priority` validates.
  if (options.priority !== undefined && !BUS_PRIORITIES.includes(options.priority)) {
    return { status: 'invalid', reason: 'invalid-priority' };
  }
  const sinceMs = options.since;
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
  const jobs = jobsSection(feed, agent, options.root, options.job, contains, sinceMs);
  const announced = announcedSection(feed, agent, options.root, options.job, contains, sinceMs);
  const { next, handoffs } = pendingWorkSections(agent, options, nowMs, registry, contains);
  // One conversations read backs all three thread views: waits the agent
  // owes, its own unanswered asks and blocked threads it is a party to.
  // A job filter narrows the shared projection to threads naming the job —
  // the same `job` query `agents conversations --job` applies — so all
  // three sections stay consistent at the frozen instant; a contains
  // filter applies the same member-subject text search
  // `agents conversations --contains` serves.
  const conversations = readAgentConversations(
    { ...(options.job === undefined ? {} : { job: options.job }),
      ...(contains === undefined ? {} : { contains }),
      ...(sinceMs === undefined ? {} : { since: sinceMs }) },
    { root: options.root, now: () => nowMs });
  const scope = conversationScope(agent, registry, identity);
  const threads = threadsSection(conversations, scope);
  const awaiting = awaitingSection(conversations, scope);
  const blocked = blockedSection(conversations, scope, nowMs);

  if (claims.status === 'ok') {
    if (feed.status === 'ok') {
      for (const claim of claims.claims) {
        claim.jobs = feed.jobs
          .filter(job => job.claimKeys.some(key => coordinationRowBlocks(claim, key)))
          .map(busClaimJobRef);
      }
    }
    annotateClaimMessages(claims.claims, options, nowMs, feed, registry);
    const job = options.job;
    if (job !== undefined) {
      // A claim lists under a job filter only when it provably relates to the
      // job: a declared-key overlap with an announced job (`jobs`, present
      // only on an ok feed) or a leased message body naming the job
      // (`jobIds`, the `busBodyJobMatch` citation set — a claim on a
      // work.post or handoff envelope relates to the job it cites). A claim
      // whose relation cannot be proven — a scope key, an unreadable feed, an
      // unresolvable message — never lists, matching every other section's
      // "unknown stays out of the match" rule.
      claims.claims = claims.claims.filter(claim =>
        claim.jobs?.some(ref => ref.id === job) === true ||
        (claim.message?.status === 'resolved' && claim.message.jobIds?.includes(job) === true));
    }
    if (contains !== undefined) {
      // A claim lists under a text filter only when its displayed evidence
      // carries the needle: a blocked announced job's title or newest status
      // detail (`claim.jobs`, present only on an ok feed) or the resolved
      // leased message's scrubbed summary. A claim with neither — a bare
      // scope key, an unreadable feed, an unresolvable message — names no
      // provable text and never lists, the same "unknown stays out" rule
      // the job filter applies; the claim key itself is a structured field,
      // never search text.
      claims.claims = claims.claims.filter(claim => claimContainsMatch(claim, contains));
    }
    if (sinceMs !== undefined) {
      // A claim lists under a time filter only when its recorded start
      // reaches the cutoff — `started` is the lease's ISO acquisition time,
      // and a null start is unknown, never a match: the same "unknown stays
      // out" rule every other section's missing timestamp follows. A claim
      // first taken before the cutoff stays pending but is not new.
      claims.claims = claims.claims.filter(claim =>
        claim.started !== null && Date.parse(claim.started) >= sinceMs);
    }
    if (options.priority !== undefined) {
      // A claim lists under a band filter only when its leased envelope
      // provably reports that band — the resolved message's own priority,
      // the same evidence `message.priority` carries. A claim with no
      // resolved message — a scope-key claim, an unresolvable or unreadable
      // lease — names no provable band and never lists, the same "unknown
      // stays out" rule the job filter applies.
      claims.claims = claims.claims.filter(claim =>
        claim.message?.status === 'resolved' && claim.message.priority === options.priority);
    }
  }

  const page = readAgentWakes(agent, sinceMs,
    { root: options.root, runsRoot: options.runsRoot, now: () => nowMs },
    { ...(options.job === undefined ? {} : { job: options.job }),
      ...(contains === undefined ? {} : { contains }),
      ...(options.priority === undefined ? {} : { priority: options.priority }) });
  const wakes: BusWorkMineWakes = page.status === 'ok'
    ? { status: 'ok', agent: page.agent, scope: page.scope, matched: page.matched,
        truncated: page.truncated || page.matched > WORK_MINE_WAKES_MAX,
        wakes: page.wakes.slice(-WORK_MINE_WAKES_MAX) }
    : { status: page.status, reason: page.reason };

  const inbox = inboxSection(agent, options, nowMs, contains);
  const mailbox = mailboxSection(agent, identity, options, nowMs, contains);
  const board = boardSection(agent, identity, options, nowMs, contains);
  // Channel memberships come from the same registry read the other sections
  // resolve addressing through — no second store walk. A `missing` registry
  // is verified-empty; `unavailable` stays unknown, never an empty list. An
  // unregistered ref has no handle and provably belongs to no channel.
  const channels: BusWorkMineChannels = read.status !== 'ok'
    ? { status: 'unavailable', reason: read.reason }
    : { status: 'ok', source: read.source,
        channels: (registry?.channels ?? [])
          .filter(channel => identity !== undefined && channel.members.includes(identity.handle))
          .map(channel => ({ name: channel.name, memberCount: channel.members.length }))
          .sort((a, b) => a.name.localeCompare(b.name)) };

  return { status: 'ok', agent: who, asOf,
    ...(options.job === undefined ? {} : { job: options.job }),
    ...(options.contains === undefined ? {} : { contains: options.contains }),
    ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString() }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    claims, jobs, announced, next, handoffs, threads, awaiting, blocked, wakes, inbox, mailbox, board,
    channels };
}

/** Human suffix naming the message an `origin:'message'` claim leases; '' on every other claim. */
function claimMessageSuffix(message: BusWorkMineClaimMessage | undefined): string {
  if (message === undefined) return '';
  if (message.status === 'resolved') {
    const kind = message.bodyKind === null ? '' : ` ${message.bodyKind}`;
    const job = message.job === undefined ? '' : ` ${busInboxJobMarker(message.job)}`;
    const pinned = message.pinned === true ? '' : ` pinned=${message.pinned === null ? 'unknown' : 'no'}`;
    return ` msg=${message.id}${kind} "${message.summary}" from=${message.from} to=${message.to}${job}${pinned}`;
  }
  return ` msg=${message.id} ${message.status}`;
}

/** Scrubbed, single-line, clipped display field; '' when nothing readable remains. */
function mineField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `holders=` display field: '-' when the hold set is unknown, 'none' when coverage shows no holds, else `key>owner@until/origin` entries. */
function mineHolders(list: BusWorkMineJobHold[] | null): string {
  if (list === null) return '-';
  if (list.length === 0) return 'none';
  return mineField(list.map(hold => `${hold.claimKey}>${hold.owner}@` +
    `${new Date(hold.leaseUntil).toISOString()}/${hold.origin}`).join(','), 600);
}

/** Human lines for `agents bus work mine`; JSON carries the full projection. */
export function formatBusWorkMine(result: BusWorkMineResult): string[] {
  if (result.status !== 'ok') return [`${result.status}: ${result.reason}`];
  const lines: string[] = [];
  const who = result.agent;
  lines.push(`agent=${who.handle ?? who.ref} ref=${who.ref} identity=${who.identity ?? '-'} ` +
    `registry=${who.registry} as-of=${result.asOf}` +
    (result.job === undefined ? '' : ` job=${result.job}`) +
    (result.contains === undefined ? '' : ` contains="${result.contains}"`) +
    (result.since === undefined ? '' : ` since=${result.since}`) +
    (result.priority === undefined ? '' : ` priority=${result.priority}`));

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
        `until=${new Date(row.leaseUntil).toISOString()} source=${row.sourceId} jobs=${blocked}` +
        claimMessageSuffix(row.message));
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
        `claimable=${claimable} addressed=${job.addressed} announced=${job.announced} owner=${job.owner} repo=${job.repo}${busWorkJobDispatch(job.dispatch)} ` +
        `free=${keys(job.freeKeys)} held=${keys(job.heldKeys)} holders=${mineHolders(job.holders)} post=${job.postId}` +
        `${job.statusId === null ? '' : ` status=${job.statusId}`}${busWorkJobResultSuffix(job)}`);
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
        `owner=${job.owner} to=${job.to} provider=${job.provider} repo=${job.repo}${busWorkJobDispatch(job.dispatch)} keys=${keys} ` +
        `held=${held} free=${keyList(job.freeKeys)} heldkeys=${keyList(job.heldKeys)} holders=${mineHolders(job.holders)} ` +
        `updated=${new Date(job.updatedAt).toISOString()} post=${job.postId}` +
        `${job.statusId === null ? '' : ` status=${job.statusId}`}${busWorkJobResultSuffix(job)}`);
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
        agentWakeClaimHolderSuffix(wake) + agentWakeMessageSuffix(wake));
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

  const board = result.board;
  if (board.status !== 'ok') {
    lines.push(`board=unknown ${board.status}`);
  } else {
    const peers = board.peers.length === 0 ? '-' : board.peers.join(',');
    lines.push(`board peers=${peers} claims=${board.claims} threads=${board.threads.length} ` +
      `deliveries=${board.deliveries.matched} shown=${board.deliveries.items.length}` +
      `${board.deliveries.truncated ? '+truncated' : ''} tasks=${board.tasks.matched} ` +
      `shown=${board.tasks.items.length}${board.tasks.truncated ? '+truncated' : ''}`);
    for (const thread of board.threads) {
      const title = mineField(neutralisePageText(thread.content.text), 80);
      const counts = thread.tasks;
      lines.push(`  thread ${thread.id} members=${thread.members.join(',')} ` +
        `pending=${thread.pendingDeliveries} tasks=open:${counts.open},held:${counts.held},` +
        `ambiguous:${counts.ambiguous},unknown:${counts.unknown}` +
        `${title === '' ? '' : ` "${title}"`}`);
    }
    for (const delivery of board.deliveries.items) {
      lines.push(`  [delivery id=${delivery.id} thread=${delivery.threadId} from ${delivery.sender} ` +
        `to ${delivery.recipient}] ${delivery.summary}`);
    }
    for (const task of board.tasks.items) {
      const owner = task.owner === null ? '' :
        ` owner=${task.owner.peerId} until=${new Date(task.owner.leaseUntil).toISOString()}`;
      lines.push(`  [task id=${task.id} thread=${task.threadId} item=${task.itemId} hold=${task.hold}` +
        `${task.claimed ? ' claimed' : ''}${owner}] ${task.title}`);
    }
  }

  const channels = result.channels;
  if (channels.status !== 'ok') {
    lines.push(`channels=unknown ${channels.status}`);
  } else {
    const names = channels.channels.map(channel => `${channel.name}(${channel.memberCount})`).join(',');
    lines.push(`channels=${channels.channels.length} source=${channels.source}${names === '' ? '' : ` ${names}`}`);
  }

  const seats = result.seats;
  if (seats !== undefined) {
    if (seats.status !== 'ok') {
      lines.push(`seats=unknown ${seats.status}`);
    } else {
      lines.push(`seats=${seats.matched} shown=${seats.seats.length}${seats.truncated ? '+truncated' : ''}`);
      for (const seat of seats.seats) {
        const refs = seat.handoffs.map(h => `${h.work.kind}:${h.work.ref}`).join(' ');
        lines.push(`  seat=${seat.seatId} participant=${seat.participantId} state=${seat.state} ` +
          `handoffs=${seat.handoffs.length}${refs === '' ? '' : ` ${mineField(refs, 400)}`}`);
      }
    }
  }
  return lines;
}
