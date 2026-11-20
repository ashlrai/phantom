/**
 * `agents bus work mine`: one read answering "what is pending for this agent" —
 * the live claims it holds under any of its labels, the open work-feed jobs it
 * could still claim, the claimable work envelopes and worker-handoff
 * assignments addressed to it — under any of its labels or to a channel it
 * belongs to — in `bus next` order, the wake hints addressed to
 * it and the next page of mail in its inbox. Each section reads the same
 * projection the dedicated verb
 * serves and keeps its honesty rules: an unreadable store, coordination table,
 * registry or wake queue narrows the match or reports unknown, never an empty
 * list passed off as fact. Routing labels are not authentication; claims
 * coordinate scope and grant no execution authority. Read-only: no writes, no
 * claims, no dispatch.
 */
import { coordinationRowBlocks, listCoordination } from './claim-store.js';
import { listBusClaims, type BusClaimsListClaim, type BusClaimsOwnerMatch } from './bus-claims.js';
import { agentLabels, readAgentRegistry, resolveAgent, type AgentRegistry } from './bus-identity.js';
import { BUS_FEED_OPEN_STATUSES, busWorkFeedOwnerMatcher, busWorkFeedToMatcher, readBusWorkFeed,
  type BusWorkFeedJob, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { busBodyFallbackSummary, busBodySummary, readAgentInbox, readAgentWakes,
  type InboxKind } from './bus-unified.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { BUS_PROTOCOL_KEY, BUS_PRIORITIES, isClaimableWork,
  type BusPriority } from '../fleet/bus-envelope.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { isWorkerHandoffBody } from '../fleet/handoff-body.js';
import type { BusWakeRow } from '../fleet/bus-wake-queue.js';
import { scrubSecrets } from '../util/scrub.js';

export interface BusWorkMineOptions {
  /** Fleet root shared by the bus store, identity registry and coordination table. */
  root?: string;
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  /** Injectable clock, frozen once so every section reads the same instant. */
  now?: () => number;
}

/** How completely the coordination holds behind the feed are known. */
export type BusWorkMineHoldCoverage = 'complete' | 'truncated' | 'unknown';

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
      receipts: number }
  | { status: 'unavailable' | 'retryable' | 'invalid' };

export type BusWorkMineWakes =
  | { status: 'ok'; agent: string; wakes: BusWakeRow[]; truncated: boolean }
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
}

export type BusWorkMineInbox =
  | { status: 'ok'; agent: string; messages: BusWorkMineInboxMessage[];
      /** Resume cursor for `agents bus inbox --after`; covers every scanned row. */
      nextCursor: number;
      /** True only when mail beyond the shown page provably exists. */
      truncated: boolean }
  | { status: 'unknown-agent' | 'unavailable' | 'retryable' | 'invalid'; reason: string };

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

export type BusWorkMineResult =
  | { status: 'ok'; agent: BusWorkMineAgent; asOf: string;
      claims: BusWorkMineClaims; jobs: BusWorkMineJobs; next: BusWorkMineNext;
      handoffs: BusWorkMineHandoffs; wakes: BusWorkMineWakes; inbox: BusWorkMineInbox }
  | { status: 'invalid'; reason: string };

/** Newest open jobs, newest wake hints and next inbox page a digest shows; totals stay honest via `open`/`truncated`. */
const WORK_MINE_JOBS_MAX = 50;
const WORK_MINE_WAKES_MAX = 20;
const WORK_MINE_INBOX_MAX = 20;
/** Claimable envelopes and handoffs a digest shows in claim order; `matched` keeps the true total. */
const WORK_MINE_NEXT_MAX = 10;
const WORK_MINE_HANDOFFS_MAX = 20;
/** Bounded scan over the retained store, same page bound the inbox reader uses. */
const WORK_MINE_NEXT_MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
/** Display clip for one mail summary; the digest carries no raw body, so JSON and human output share it. */
const WORK_MINE_SUMMARY_MAX = 200;

const AGENT_REF = /^[\x21-\x7e]{1,128}$/;

/**
 * The hold-coverage rule every "is this job claimable" surface shares:
 * `complete` means every live hold is shown, so an unheld declared key is
 * provably free; `truncated` means shown holds are real but later ones are
 * not, so a key with no shown hold might still be held; `unknown` means the
 * hold set could not be read at all. `claimable` is true only on a provably
 * free key, false only when every declared key is provably held.
 */
export function busWorkMineJobAnnotation(
  job: BusWorkFeedJob, held: ReadonlySet<string> | undefined, coverage: BusWorkMineHoldCoverage,
  addressed: boolean, announced = false,
): BusWorkMineJob {
  const heldKeys = coverage === 'unknown' ? null : job.claimKeys.filter(key => held?.has(key));
  const freeKeys = coverage === 'complete' ? job.claimKeys.filter(key => !held?.has(key)) : null;
  const claimable = coverage === 'unknown' ? null
    : coverage === 'complete' ? job.claimKeys.some(key => !held?.has(key))
    : heldKeys !== null && heldKeys.length === job.claimKeys.length ? false : null;
  return { ...job, addressed, announced, freeKeys, heldKeys, claimable };
}

function jobsSection(feed: BusWorkFeedReadResult, agent: string, root: string | undefined): BusWorkMineJobs {
  if (feed.status === 'refused') return { status: 'refused', reason: feed.reason, receipts: feed.receipts };
  if (feed.status !== 'ok') return { status: feed.status };
  const claims = feed.claims;
  const coverage: BusWorkMineHoldCoverage =
    claims === undefined || claims.source === 'unavailable' ? 'unknown'
    : claims.truncated ? 'truncated' : 'complete';
  const heldByJob = new Map<string, Set<string>>();
  for (const hold of claims?.holds ?? []) {
    const set = heldByJob.get(hold.jobId) ?? new Set<string>();
    set.add(hold.claimKey);
    heldByJob.set(hold.jobId, set);
  }
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
 * The next page of mail addressed to the agent — the same matching, order and
 * owner-share receipt checks `agents bus inbox` applies, capped at the oldest
 * WORK_MINE_INBOX_MAX pending messages. One extra row is read past the cap so
 * `truncated` is definitive: a full window proves mail remains beyond
 * `nextCursor`, a short one proves the scan reached the store's end. When the
 * window overflows the newest row is the one dropped, so `nextCursor` resumes
 * strictly before it and `agents bus inbox --after` redelivers nothing shown
 * and skips nothing pending.
 */
function inboxSection(agent: string, options: BusWorkMineOptions, nowMs: number): BusWorkMineInbox {
  const page = readAgentInbox(agent, { limit: WORK_MINE_INBOX_MAX + 1 }, { root: options.root, now: () => nowMs });
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
    messages: shown.map(message => ({
      cursor: message.cursor, id: message.envelope.id, ts: new Date(message.receivedAt).toISOString(),
      priority: message.priority, kind: message.kind, channel: message.channel,
      from: message.envelope.from, fromAgent: message.fromAgent,
      summary: mineField(busBodySummary(message.envelope.body) ?? busBodyFallbackSummary(message.envelope.body),
        WORK_MINE_SUMMARY_MAX),
    })),
  };
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
 * receivable `worker-handoff`, and whose `to` label resolves to the agent
 * under the same identity matching the feed `--to` filter and `bus next` use
 * or names a `group:<channel>:<topic>` address of a channel the resolved
 * identity belongs to — the same membership rule the inbox and wake reads
 * apply, minus the agent's own channel posts — ordered the way
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
  const toMatch = busWorkFeedToMatcher(agent, { root: options.root });
  // Channel membership widens "addressed to this agent" exactly the way the
  // inbox and wake reads do: `group:<name>:` prefixes of channels whose member
  // list holds the resolved handle, excluding posts the agent sent itself. A
  // missing or unreadable registry — or a ref resolving to no identity —
  // contributes no channels, so matching never widens on unknown state.
  const identity = registry === undefined ? undefined : resolveAgent(registry, agent);
  const selfLabels = new Set(identity === undefined ? [] : agentLabels(identity));
  const channelPrefixes = registry === undefined || identity === undefined ? [] : registry.channels
    .filter(channel => channel.members.includes(identity.handle))
    .map(channel => `group:${channel.name}:`);
  const pendingAddress = (to: string, from: string): boolean =>
    toMatch(to) || (channelPrefixes.length > 0 && !selfLabels.has(from) &&
      channelPrefixes.some(prefix => to.startsWith(prefix)));
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
 * Compose the reads one agent otherwise runs separately — `claim list
 * --owner`, `work feed`, the `bus next` and `handoff-receive` walks, `wakes`
 * and `inbox` — into one snapshot. The claims
 * join names the announced jobs each held claim's keys block, from the same
 * feed read the jobs section annotates, so the two views cannot disagree. A
 * non-ok feed leaves `jobs` absent on claims and reports its own state in the
 * jobs section; non-ok claims, next, handoffs, wakes or inbox reads report
 * their own state rather than zero or an empty list.
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
  const { next, handoffs } = pendingWorkSections(agent, options, nowMs, registry);

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
    ? { status: 'ok', agent: page.agent, truncated: page.wakes.length > WORK_MINE_WAKES_MAX,
        wakes: page.wakes.slice(-WORK_MINE_WAKES_MAX) }
    : { status: page.status, reason: page.reason };

  const inbox = inboxSection(agent, options, nowMs);

  return { status: 'ok', agent: who, asOf, claims, jobs, next, handoffs, wakes, inbox };
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
    lines.push(`jobs=unknown feed=${jobs.status}${jobs.status === 'refused' ? `:${jobs.reason}` : ''}`);
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

  const wakes = result.wakes;
  if (wakes.status !== 'ok') {
    lines.push(`wakes=unknown ${wakes.status}`);
  } else {
    lines.push(`wakes=${wakes.wakes.length}${wakes.truncated ? '+truncated' : ''}`);
    for (const wake of wakes.wakes) {
      lines.push(`  ${new Date(wake.at).toISOString()} ${wake.id} ${wake.from} -> ${wake.to}`);
    }
  }

  const inbox = result.inbox;
  if (inbox.status !== 'ok') {
    lines.push(`inbox=unknown ${inbox.status}`);
  } else {
    lines.push(`inbox=${inbox.messages.length}${inbox.truncated ? '+truncated' : ''} nextCursor=${inbox.nextCursor}`);
    for (const message of inbox.messages) {
      const where = message.kind === 'channel' ? `#${message.channel}` : message.kind;
      const from = message.fromAgent ? `agent:${message.fromAgent}` : `label ${message.from}`;
      lines.push(`  [${message.priority} ${where} id=${message.id} from ${from}] ${message.summary}`);
    }
  }
  return lines;
}
