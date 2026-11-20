/**
 * `agents bus work mine`: one read answering "what is pending for this agent" —
 * the live claims it holds under any of its labels, the open work-feed jobs it
 * could still claim, and the wake hints addressed to it. Each section reads the
 * same projection the dedicated verb serves and keeps its honesty rules: an
 * unreadable store, coordination table, registry or wake queue narrows the
 * match or reports unknown, never an empty list passed off as fact. Routing
 * labels are not authentication; claims coordinate scope and grant no
 * execution authority. Read-only: no writes, no claims, no dispatch.
 */
import { coordinationRowBlocks } from './claim-store.js';
import { listBusClaims, type BusClaimsListClaim, type BusClaimsOwnerMatch } from './bus-claims.js';
import { readAgentRegistry, resolveAgent } from './bus-identity.js';
import { BUS_FEED_OPEN_STATUSES, busWorkFeedToMatcher, readBusWorkFeed,
  type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import { readAgentWakes } from './bus-unified.js';
import type { BusWakeRow } from '../fleet/bus-wake-queue.js';
import type { WorkJob } from './bus-v2-schema.js';
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
export interface BusWorkMineJob extends WorkJob {
  /** True when the announcement `to` label resolves to this agent's identity; false keeps exact-label misses honest. */
  addressed: boolean;
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

export type BusWorkMineResult =
  | { status: 'ok'; agent: BusWorkMineAgent; asOf: string;
      claims: BusWorkMineClaims; jobs: BusWorkMineJobs; wakes: BusWorkMineWakes }
  | { status: 'invalid'; reason: string };

/** Newest open jobs and newest wake hints a digest shows; totals stay honest via `open`/`truncated`. */
const WORK_MINE_JOBS_MAX = 50;
const WORK_MINE_WAKES_MAX = 20;

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
  job: WorkJob, held: ReadonlySet<string> | undefined, coverage: BusWorkMineHoldCoverage,
  addressed: boolean,
): BusWorkMineJob {
  const heldKeys = coverage === 'unknown' ? null : job.claimKeys.filter(key => held?.has(key));
  const freeKeys = coverage === 'complete' ? job.claimKeys.filter(key => !held?.has(key)) : null;
  const claimable = coverage === 'unknown' ? null
    : coverage === 'complete' ? job.claimKeys.some(key => !held?.has(key))
    : heldKeys !== null && heldKeys.length === job.claimKeys.length ? false : null;
  return { ...job, addressed, freeKeys, heldKeys, claimable };
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
  return {
    status: 'ok', holds: coverage, open: open.length, receipts: feed.receipts,
    truncated: open.length > WORK_MINE_JOBS_MAX,
    jobs: open.slice(0, WORK_MINE_JOBS_MAX).map(job =>
      busWorkMineJobAnnotation(job, heldByJob.get(job.id), coverage, toMatch(job.to))),
  };
}

/**
 * Compose the three reads one agent otherwise runs separately — `claim list
 * --owner`, `work feed` and `wakes` — into one snapshot. The claims join names
 * the announced jobs each held claim's keys block, from the same feed read the
 * jobs section annotates, so the two views cannot disagree. A non-ok feed
 * leaves `jobs` absent on claims and reports its own state in the jobs
 * section; a non-ok claims read reports `unavailable` rather than zero.
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

  if (claims.status === 'ok' && feed.status === 'ok') {
    for (const claim of claims.claims) {
      claim.jobs = feed.jobs
        .filter(job => job.claimKeys.some(key => coordinationRowBlocks(claim, key)))
        .map(job => ({ id: job.id, owner: job.owner, status: job.status, title: job.title }));
    }
  }

  const page = readAgentWakes(agent, undefined,
    { root: options.root, runsRoot: options.runsRoot, now: () => nowMs });
  const wakes: BusWorkMineWakes = page.status === 'ok'
    ? { status: 'ok', agent: page.agent, truncated: page.wakes.length > WORK_MINE_WAKES_MAX,
        wakes: page.wakes.slice(-WORK_MINE_WAKES_MAX) }
    : { status: page.status, reason: page.reason };

  return { status: 'ok', agent: who, asOf, claims, jobs, wakes };
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
      const keys = (list: string[] | null): string => list === null ? '-' : mineField(list.join(','), 400);
      const claimable = job.claimable === null ? 'unknown' : job.claimable ? 'yes' : 'no';
      lines.push(`  ${job.id} ${job.status}${title === '' ? '' : ` "${title}"`} ` +
        `claimable=${claimable} addressed=${job.addressed} owner=${job.owner} repo=${job.repo} ` +
        `free=${keys(job.freeKeys)} held=${keys(job.heldKeys)}`);
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
  return lines;
}
