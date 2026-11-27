/**
 * Fleet coordination ledger claim churn → self-improvement backlog items.
 *
 * The agent bus's advisory claim ledger — claimFleetWork,
 * handoffFleetClaim, releaseFleetClaim, returnFleetClaim and the post /
 * assign verbs behind `phm fleet coordination` — appends every lifecycle
 * event to fleet/coordination.jsonl (fleetCoordinationPath in
 * src/core/fleet/coordination.ts): `claim`/`handoff` rows carry the full
 * claim (repo, task, agent, lease hash), `release`/`reap` rows end a
 * claim, the rich `reap` rows record reason 'lease-expired' with the
 * owner, `return` rows are concluded claims carrying their RESULT
 * receipt intent, and `post`/`assign` rows are standalone messages and
 * work proposals. The ledger compacts under its 8 MiB / 20 000-row
 * bound, so terminal rows survive only until the next compaction —
 * whatever the bounded tail still holds is the recorded evidence.
 *
 * Two evidence kinds in that ledger never became work:
 *
 *  - Lease-expired reaps: a claim whose lease lapsed was orphaned —
 *    the holding agent died, stalled or never concluded before
 *    expiresAt. One expiry is noise; one agent's claims expiring
 *    across days means its claims routinely outlive their leases
 *    (crash mid-claim, TTL sized wrong for the work, or claim-then-
 *    abandon hygiene), and every expiry returns the work to the pool
 *    for another agent to pick up cold.
 *  - Handoff churn: the same work unit (repo + task) kept changing
 *    hands — handoff rows re-lease the claim to a new agent without
 *    concluding it. Occasional handoffs are the designed escape for a
 *    stuck holder; the same work handed off again and again across
 *    days is ping-pong — agents declining, re-assigning or bouncing
 *    the claim while nothing ever returns a RESULT receipt.
 *
 * Until now both only ever reached `phm fleet coordination board` and
 * `returns` — point-in-time reads of live state, never a trend — and
 * the unified inbox / bus surfaces that project the same pending
 * state. coordinationBacklogItems carries the journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning,
 * ci-rerun, autoland and sibling machinery feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    tail (the newest 4 MiB; the writer's own compaction bound is 8
 *    MiB); nothing is written and no network is touched. A truncated
 *    tail still folds — counts are then lower bounds of the window.
 *  - Missing or unreadable evidence yields no items. An absent ledger
 *    reads as an empty event list; rows the reader cannot validate —
 *    bad JSON, wrong version, missing or mistyped fields — never
 *    reach the fold.
 *  - Fleet machinery, fleet repo. Claims coordinate work across every
 *    repository the fleet serves, but the lease, handoff and reap
 *    machinery this evidence faults lives in this install — items
 *    emit only for the fleet's own repository target (the
 *    fleetRepoName 'phantom' gate the sibling machinery feeds use),
 *    and the claimed work's repos appear inside the prompt as
 *    evidence, never as the item's target.
 *  - Recurring means recorded. A lease-expiry cell emits only at
 *    COORDINATION_MIN_UNITS distinct reaped claims spanning at least
 *    COORDINATION_MIN_DAYS distinct UTC days inside the window; a
 *    handoff cell emits only at COORDINATION_MIN_UNITS handoffs on
 *    the same work spanning the same bar. One crash and one
 *    deliberate reassignment never queue a session.
 *  - Future-stamped rows wait. An event `at` beyond now plus the
 *    sibling feeds' one-minute skew is corrupt evidence and never
 *    reaches a cell; rows inside the skew count normally.
 *  - Unknown stays unknown. Plain `reap` rows carry no owner or
 *    reason (no current writer produces them) and `release` rows are
 *    deliberate unreceipted endings, so neither feeds a cell; reap
 *    rows whose claim row fell out of the tail or was compacted away
 *    still count toward their owner's cell but name no repo.
 *  - Dedup is downstream. Item ids hash the cell identity (kind +
 *    owner, or kind + normalized work key — never the counts,
 *    agents or timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a cell that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, identifiers are scrubbed and flattened
 *    to one line, and the brief names the journal, the
 *    `phm fleet coordination` reads and the machinery modules with
 *    the usual no-change escape when the window no longer
 *    reproduces or the cause is owner-side.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { fleetCoordinationPath } from '../fleet/coordination.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by the window's own event diversity. */
export const COORDINATION_MAX_ITEMS = 8;
const COORDINATION_ITEM_HARD_MAX = 25;
/** The evidence window both cells anchor on — the sibling feeds' 7-day recurrence convention. */
export const COORDINATION_WINDOW_MS = 7 * 86_400_000;
/** Future-skew ceiling on event `at` stamps, the sibling feeds' one-minute allowance. */
export const COORDINATION_FUTURE_SKEW_MS = 60_000;
/** Distinct units (reaped claims, or handoffs on one work) a cell needs inside the window. */
export const COORDINATION_MIN_UNITS = 3;
/** Distinct UTC days the units must span — recurring means recorded across days. */
export const COORDINATION_MIN_DAYS = 2;
/** Bounded tail read; the writer compacts at 80% of its 8 MiB bound, so 4 MiB covers the live half. */
const COORDINATION_TAIL_BYTES = 4 * 1024 * 1024;
/** A return row's message body is capped at 4 000 chars by the writer; 16 KiB is generous headroom. */
const MAX_EVENT_LINE_CHARS = 16 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded identifiers and tasks are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Task text quoted inside one prompt before the remainder is elided. */
const MAX_TASK_CHARS = 120;
/** Repos / agents / days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_EXAMPLES = 3;
/** The fleet's own repository label: coordination evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface CoordinationItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Coordination ledger override (default: fleetCoordinationPath(), the writer's own ~/.ashlr/fleet/coordination.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default COORDINATION_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window, ms epoch (default: now). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdent = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

const isStamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const LEASE_HASH = /^[a-f0-9]{64}$/;

interface ClaimRef {
  repo: string;
  task: string;
}

interface ParsedEvents {
  /** claim id → the work it coordinates (repo + task never change across handoffs). */
  claims: Map<string, ClaimRef>;
  /** claim id → the holder its latest claim/handoff event recorded. */
  holders: Map<string, string>;
  /** Lease-expired reaps in file order: owner + claim id + event stamp. */
  leaseReaps: { owner: string; id: string; at: number }[];
  /** Handoff events in file order with their work key and holder transition. */
  handoffs: { workKey: string; repo: string; task: string; claimId: string; from: string; to: string; at: number }[];
  /** Concluded returns in file order, for per-owner context tallies. */
  returns: { agent: string; at: number }[];
}

/**
 * One ledger line → its validated event contribution, or null. Mirrors
 * the writer's own shape checks closely enough that a row which parses
 * here is a row coordination.ts would accept; rows it rejects are
 * skipped, never guessed at.
 */
function parseEventLine(
  raw: unknown,
  claims: Map<string, ClaimRef>,
  holders: Map<string, string>,
  leaseReaps: ParsedEvents['leaseReaps'],
  handoffs: ParsedEvents['handoffs'],
  returns: ParsedEvents['returns'],
): void {
  if (!isObject(raw) || raw['version'] !== 1 || !isStamp(raw['at'])) return;
  const at = raw['at'] as number;
  const kind = raw['kind'];
  if (kind === 'claim' || kind === 'handoff') {
    const claim = raw['claim'];
    if (!isObject(claim) || !isIdent(claim['id']) || typeof claim['repo'] !== 'string' || claim['repo'] === ''
      || claim['repo'].length > 200 || typeof claim['task'] !== 'string' || claim['task'].trim() === ''
      || claim['task'].length > 1000 || !isIdent(claim['agent'])
      || !isStamp(claim['claimedAt']) || !isStamp(claim['expiresAt']) || (claim['expiresAt'] as number) <= (claim['claimedAt'] as number)
      || typeof claim['leaseHash'] !== 'string' || !LEASE_HASH.test(claim['leaseHash'])) return;
    const id = claim['id'] as string;
    const repo = claim['repo'];
    const task = claim['task'];
    claims.set(id, { repo, task });
    if (kind === 'handoff') {
      // The event's agent is the NEW holder; the from-agent is the
      // holder the claim/handoff events recorded last for this id —
      // '' when the prior claim row fell out of the tail or was
      // compacted away, never a guess.
      const from = holders.get(id) ?? '';
      handoffs.push({
        workKey: `${repo.toLowerCase()}\n${task.trim().replace(/\s+/g, ' ').toLowerCase()}`,
        repo,
        task,
        claimId: id,
        from,
        to: claim['agent'] as string,
        at,
      });
    }
    holders.set(id, claim['agent'] as string);
    return;
  }
  if (kind === 'release' || kind === 'reap') {
    if (!isIdent(raw['id'])) return;
    // The plain reap shape carries no owner or reason — no current writer
    // produces it — so it stays out of every cell rather than guessing.
    if (kind === 'reap' && isObject(raw) && raw['reason'] === 'lease-expired'
      && raw['state'] === 'RELEASED' && isIdent(raw['owner'])
      && Object.keys(raw).length === 7) {
      leaseReaps.push({ owner: raw['owner'] as string, id: raw['id'] as string, at });
    }
    return;
  }
  if (kind === 'return') {
    const message = raw['message'];
    if (!isIdent(raw['id']) || !isIdent(raw['agent']) || typeof raw['leaseHash'] !== 'string'
      || !LEASE_HASH.test(raw['leaseHash']) || !isObject(message) || !isStamp(message['at']) || !isStamp(message['expiresAt'])) return;
    returns.push({ agent: raw['agent'] as string, at });
    return;
  }
  // post and assign rows carry no claim-lifecycle evidence this fold uses.
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const inWindow = (at: number, nowMs: number): boolean =>
  at >= nowMs - COORDINATION_WINDOW_MS && at <= nowMs + COORDINATION_FUTURE_SKEW_MS;

interface LeaseCell {
  owner: string;
  /** Distinct claim ids lease-expired in the window. */
  claims: Set<string>;
  /** Distinct UTC days those reaps were journaled on. */
  days: Set<string>;
  /** Work repo → reaped-claim count, best-effort via the claim rows still in the tail. */
  repos: Map<string, number>;
  /** Concluded returns the same owner recorded in the window, for context. */
  returns: number;
}

interface HandoffCell {
  workKey: string;
  repo: string;
  task: string;
  /** Handoff events on this work in the window. */
  handoffs: number;
  /** Distinct claim ids those handoffs rode on. */
  claims: Set<string>;
  /** Holder agents seen on the transitions (from and to), in first-seen order. */
  agents: string[];
  /** Distinct UTC days the handoffs were journaled on. */
  days: Set<string>;
}

const NO_CHANGE = 'If the window has rolled forward, the claims or agents changed, or the cause is owner-side (host sleep, pinned contrib/mac machinery, credentials or billing) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is fleet/coordination.jsonl under the Phantom state directory (~/.ashlr or $ASHLR_HOME, PHANTOM_FLEET_LEDGER_PATH overrides it), the advisory claim ledger written by src/core/fleet/coordination.ts — `phm fleet coordination board --json` reads the live claims/messages/proposals, `phm fleet coordination returns --json` reads the RESULT receipts, and `phm fleet coordination <claim|release|return|handoff|post|assign>` appends the lifecycle events this fold counts (the expiry itself is journaled by reapExpiredClaims in src/core/fleet/claim-lease-reap.ts when the next mutation or board read notices expiresAt has passed).';

function leasePrompt(cell: LeaseCell): string {
  const owner = fieldText(cell.owner);
  const days = [...cell.days].sort();
  const repos = [...cell.repos.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const repoText = repos.length === 0
    ? 'no claim row for them survives in the bounded tail, so the work repos are unknown'
    : repos.slice(0, MAX_PROMPT_EXAMPLES).map(([repo, count]) => `'${fieldText(repo)}' (${count})`).join(', ')
      + (repos.length > MAX_PROMPT_EXAMPLES ? `, and ${repos.length - MAX_PROMPT_EXAMPLES} more` : '');
  return [
    `Phantom's fleet coordination ledger shows agent '${owner}'s claims keep expiring mid-lease — ${cell.claims.size} distinct claims lease-expired across ${days.length} days inside the ${Math.round(COORDINATION_WINDOW_MS / 86_400_000)}-day window.`,
    '',
    `Each rich reap row is a claim whose expiresAt passed while its holder still owned it: the agent died, stalled or never concluded before the lease lapsed, and the work returned to the pool for another agent to pick up cold. The same window recorded ${cell.returns} concluded return(s) for this agent — expiry is the exception path, not the norm. Work repos seen on the expired claims: ${repoText}.`,
    '',
    EVIDENCE,
    '',
    `Find out why this agent's claims outlive their leases: check whether its sessions crash or stall between claim and return (jobs ledger finish/launch rows for the same agent label), whether the --ttl-seconds it claims with is sized for the work, and whether it claims and then abandons. If the expiries trace to pinned ops machinery, host sleep or owner-side causes the repo cannot fix, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function leaseItem(cell: LeaseCell, repo: string): CloudBacklogItem {
  const owner = fieldText(cell.owner);
  const id = `coord-lease-${createHash('sha256').update(`coord-lease:${owner.toLowerCase()}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Fleet claims by '${owner.slice(0, 60)}' keep expiring mid-lease`.slice(0, MAX_TITLE_CHARS),
    prompt: leasePrompt(cell),
    area: 'fleet-coordination',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function handoffPrompt(cell: HandoffCell): string {
  const repo = fieldText(cell.repo);
  const task = fieldText(cell.task, MAX_TASK_CHARS);
  const days = [...cell.days].sort();
  const agents = [...new Set(cell.agents.map((agent) => fieldText(agent)))].slice(0, MAX_PROMPT_EXAMPLES);
  const agentText = agents.length === 0 ? 'unrecorded' : agents.join(', ');
  return [
    `Phantom's fleet coordination ledger shows work on ${repo} — "${task}" — keeps changing hands: ${cell.handoffs} handoffs across ${cell.claims.size} distinct claims in ${days.length} days inside the ${Math.round(COORDINATION_WINDOW_MS / 86_400_000)}-day window.`,
    '',
    `A handoff re-leases the claim to a new agent without concluding it; the holders seen on these handoffs were ${agentText}. Occasional handoffs are the designed escape for a stuck holder, but the same work churning across days means agents keep picking it up and passing it on while no RESULT receipt ever lands — check \`phm fleet coordination returns --repo ${repo} --json\` for whether any conclusion was ever recorded.`,
    '',
    EVIDENCE,
    '',
    `Find out why this work ping-pongs: is the task ambiguous or too large for one claim's TTL, are agents declining it for missing context or capability, or is a lease-handoff path re-assigning it automatically? If the churn traces to pinned ops machinery, owner-side causes or deliberate human reassignment, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function handoffItem(cell: HandoffCell, repo: string): CloudBacklogItem {
  const displayRepo = fieldText(cell.repo);
  const displayTask = fieldText(cell.task, MAX_TASK_CHARS);
  const task = displayTask.length > 60 ? `${displayTask.slice(0, 59)}…` : displayTask;
  const id = `coord-handoff-${createHash('sha256').update(`coord-handoff:${cell.workKey}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Fleet work on ${displayRepo} "${task}" keeps changing hands`.slice(0, MAX_TITLE_CHARS),
    prompt: handoffPrompt(cell),
    area: 'fleet-coordination',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the coordination ledger's recurring lease-expired
 * reaps and handoff churn. Total: another repository target, a missing
 * ledger, an unreadable read or any fold failure yields no items rather
 * than throwing into discovery.
 */
export async function coordinationBacklogItems(opts: CoordinationItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const journalPath = opts.journalPath ?? fleetCoordinationPath();
    const nowMs = opts.now ?? Date.now();
    const tail = await readLedgerTail(journalPath, COORDINATION_TAIL_BYTES);
    // A missing ledger is a clean empty source; an unreadable or
    // non-file read means evidence exists that cannot be trusted —
    // fail closed. A truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];

    const claims = new Map<string, ClaimRef>();
    const holders = new Map<string, string>();
    const leaseReaps: ParsedEvents['leaseReaps'] = [];
    const handoffs: ParsedEvents['handoffs'] = [];
    const returns: ParsedEvents['returns'] = [];
    for (const line of tail.text.split('\n')) {
      if (line === '' || line.length > MAX_EVENT_LINE_CHARS) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      parseEventLine(raw, claims, holders, leaseReaps, handoffs, returns);
    }

    // Window filter applies to event stamps; the claim index itself is
    // window-free because a reap's claim row may legitimately predate it.
    const windowedReaps = leaseReaps.filter((reap) => inWindow(reap.at, nowMs));
    const windowedHandoffs = handoffs.filter((handoff) => inWindow(handoff.at, nowMs));
    const windowedReturns = returns.filter((ret) => inWindow(ret.at, nowMs));

    const leaseCells = new Map<string, LeaseCell>();
    for (const reap of windowedReaps) {
      let cell = leaseCells.get(reap.owner);
      if (cell === undefined) {
        cell = { owner: reap.owner, claims: new Set(), days: new Set(), repos: new Map(), returns: 0 };
        leaseCells.set(reap.owner, cell);
      }
      if (!cell.claims.has(reap.id)) {
        cell.claims.add(reap.id);
        cell.days.add(utcDay(reap.at));
        const claim = claims.get(reap.id);
        if (claim !== undefined) {
          const repoKey = fieldText(claim.repo).toLowerCase();
          cell.repos.set(repoKey, (cell.repos.get(repoKey) ?? 0) + 1);
        }
      }
    }
    for (const ret of windowedReturns) {
      const cell = leaseCells.get(ret.agent);
      if (cell !== undefined) cell.returns += 1;
    }

    const handoffCells = new Map<string, HandoffCell>();
    for (const handoff of windowedHandoffs) {
      let cell = handoffCells.get(handoff.workKey);
      if (cell === undefined) {
        cell = {
          workKey: handoff.workKey,
          repo: handoff.repo,
          task: handoff.task,
          handoffs: 0,
          claims: new Set(),
          agents: [],
          days: new Set(),
        };
        handoffCells.set(handoff.workKey, cell);
      }
      cell.handoffs += 1;
      cell.claims.add(handoff.claimId);
      // Both ends of the transition are evidence; an empty from means
      // the prior claim row fell out of the tail — it is skipped, not
      // guessed.
      for (const agent of [handoff.from, handoff.to]) {
        if (agent !== '' && !cell.agents.includes(agent)) cell.agents.push(agent);
      }
      cell.days.add(utcDay(handoff.at));
    }

    const recurringLease = [...leaseCells.values()]
      .filter((cell) => cell.claims.size >= COORDINATION_MIN_UNITS && cell.days.size >= COORDINATION_MIN_DAYS)
      .sort((a, b) => b.claims.size - a.claims.size || a.owner.localeCompare(b.owner));
    const recurringHandoffs = [...handoffCells.values()]
      .filter((cell) => cell.handoffs >= COORDINATION_MIN_UNITS && cell.days.size >= COORDINATION_MIN_DAYS)
      .sort((a, b) => b.handoffs - a.handoffs || a.workKey.localeCompare(b.workKey));

    const candidates: CloudBacklogItem[] = [
      ...recurringLease.map((cell) => leaseItem(cell, repo)),
      ...recurringHandoffs.map((cell) => handoffItem(cell, repo)),
    ];
    const limit = Math.max(1, Math.min(opts.limit ?? COORDINATION_MAX_ITEMS, COORDINATION_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
