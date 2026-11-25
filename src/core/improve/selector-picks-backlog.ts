/**
 * Selector picks journal + queue/jobs evidence → self-improvement backlog items.
 *
 * `phm select` (src/cli/select.ts → src/core/routing/selector.ts, hourly via
 * `phm select schedule`'s launchd agent) ranks candidates —
 * <runs>/selector/candidates.jsonl rows plus the friction ledger's top open
 * items as RQ-FRICTION-* ids — and funds the top few. For every funded pick
 * it appends one record to <runs>/selector/picks.jsonl:
 *
 *   {at, rank, id, repo, jobType, score, predictedValue, mergeRate,
 *    minutes, usage, basis, frictionId?}
 *
 * and prints the pick as a `- READY <id> (...)` line. The contract
 * (docs/contracts/CONTRACT-SELECTOR.md) is explicit about what happens next:
 * "The selector does not enqueue, claim, spend, or merge; a planner appends
 * the lines to the queue." That append is a manual agent act — the only
 * notification is a `selector.picks` bus envelope with a one-hour TTL — and
 * nothing verifies it ever happened. `fundedIds`, the journal's only other
 * reader, refuses to fund an id a second time, forever: a pick whose READY
 * line never reaches router-queue.md / queue.v1.json / ready.tsv is
 * permanently unfundable AND permanently invisible — the candidate's work is
 * silently lost while the selector keeps reporting it as funded.
 *
 * Until now the journal's only reader was that same dedupe scan: a
 * point-in-time "have we funded this id" that never folds a recurrence.
 * selectorPicksBacklogItems carries the journal into discoverBacklog by
 * joining each settled pick against every place a planner append would
 * leave evidence:
 *
 *   - metrics/jobs.jsonl (the dispatchd attempt dialect, bounded tail):
 *     launch/finish/publish/outcome rows keyed by the pick's job id —
 *     the same fold recut-loop-backlog and the sibling feeds apply.
 *   - queue/dropped.tsv: raw ready.tsv rows `phm queue order drop`
 *     archives — a pick here was queued and then killed.
 *   - queue/queue.v1.json: the `phm queue` work-market store's job ids and
 *     statuses — a planner may append there instead of the launch queue.
 *   - queue/router-queue.md: the proposal doc restock turns into
 *     ready.tsv rows — any status line naming the id means the append
 *     happened.
 *   - queue/ready.tsv: the dispatcher's live launch queue (plus its
 *     PARKED-* rows, which are deliberate holds, not launches).
 *
 * A settled pick (older than SELECTOR_PICK_SETTLE_MS, inside the 7-day
 * window) resolves to one state: 'merged' (jobs ledger recorded a MERGED
 * outcome — healthy), 'in-flight' (launched or PR-open with no verdict —
 * stuck-job and post-merge feeds own that signal), 'unmerged' (the job
 * ran to a finish/close/resolve with no merge), 'empty' (every recorded
 * finish/publish ended with no change and no PR), 'dropped' (drop archive
 * row or a DROPPED/RETIRED market status), 'never-proposed' (no evidence
 * anywhere — the planner append never happened), or 'unknown' (a source
 * that could have held the evidence was degraded, so absence proves
 * nothing — never guessed).
 *
 * Cells emit only on the recurring bar — SELECTOR_PICK_MIN_ROWS distinct
 * picks across SELECTOR_PICK_MIN_DAYS distinct UTC days — keyed by the
 * pick's recorded repo for the pipeline states and by repo+jobType for
 * the outcome states (the same granularity the selector's own mergeRate
 * prior learns at). Every emitted prompt keeps the evidence framing:
 * counts are quoted only as recorded, example ids must match the pick id
 * shape before they are quoted, truncated tails are stated as lower
 * bounds, and the brief carries the usual no-change escape.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Every source is read through its bounded tail/head reader;
 *    nothing is written and no network, lock or process is touched.
 *    Missing files are empty evidence; unreadable or oversized ones are
 *    degraded and force 'unknown' rather than a false 'never-proposed'.
 *  - The journals describe this install's selector and queues; items emit
 *    only when the backlog's repo name is the fleet's own ('phantom' last
 *    segment), the same gate the sibling fleet-evidence sources apply.
 *  - Recorded rows only. A picks.jsonl line counts only when its fields
 *    validate against the writer's shape — parseable `at`, the RQ-* id
 *    pattern, non-empty repo/jobType, finite numerics where present.
 *    Malformed lines are skipped, never guessed.
 *  - Dedup is downstream. The item id hashes the cell identity (kind +
 *    repo + cell key — never the counts or timestamps), so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; a cell that recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerPhase, ledgerPrUrl, ledgerStateTokens } from '../fleet/empty-cause.js';
import {
  isNodePoolLedgerRow,
  ledgerEventTs,
  ledgerJobId,
  ledgerLifecycleEvent,
  ledgerOutcomeState,
} from '../fleet/jobs-ledger-dialect.js';
import { parseReadyRows, readReadyText } from '../fleet/ready-row-edit.js';
import { parked } from '../queue/supersede.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells sort deterministically before the cap applies. */
export const SELECTOR_PICKS_MAX_ITEMS = 8;
const SELECTOR_PICKS_ITEM_HARD_MAX = 25;
/** Evidence window: the fleet's recurring-evidence week. */
export const SELECTOR_PICKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A pick younger than this is still inside the normal import → restock →
 * launch → merge pipeline and is 'pending' context, never evidence. Two
 * days covers a planner pass plus a queue wait plus a job run.
 */
export const SELECTOR_PICK_SETTLE_MS = 48 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const SELECTOR_PICK_SKEW_MS = 60_000;
/** Adverse picks one cell needs inside the window before its recurrence counts. */
export const SELECTOR_PICK_MIN_ROWS = 3;
/** Distinct UTC days those picks must span — recurring means recorded across days. */
export const SELECTOR_PICK_MIN_DAYS = 2;
/** Bounded tail for picks.jsonl (~300-byte rows; a week of hourly top-5 fits whole). */
export const SELECTOR_PICKS_TAIL_BYTES = 1024 * 1024;
/** Bounded reads for the queue-side evidence files. */
const QUEUE_V1_MAX_BYTES = 4 * 1024 * 1024;
const ROUTER_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const DROPPED_MAX_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 60;
/** Example pick ids quoted inside one prompt before the remainder is summarized. */
const PROMPT_EXAMPLES_MAX = 3;
/** The pick id shape the writer enforces (selector.ts ID). */
const PICK_ID_RE = /^RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
/** The fleet's own repository label: selector evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

// ---------------------------------------------------------------------------
// picks.jsonl rows
// ---------------------------------------------------------------------------

/** One validated pick record inside the journal tail. */
export interface SelectorPickRow {
  atMs: number;
  utcDay: string;
  id: string;
  /** Sanitized recorded repo label (short name, e.g. 'phantom'). */
  repo: string;
  /** Sanitized recorded job type ('work', 'friction', ...). */
  jobType: string;
  /** Recorded predicted merge rate prior; null when absent or non-finite. */
  mergeRate: number | null;
  /** Recorded predicted value; null when absent or non-finite. */
  predictedValue: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const finiteNum = (value: unknown): number | null =>
  (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse picks.jsonl text into validated pick rows. Only lines whose
 * fields satisfy the writer's contract survive — a parseable `at`, the RQ-*
 * id shape, non-empty repo and jobType after sanitizing, and finite
 * numerics where present. Malformed lines are dropped, never guessed.
 * The first row per id wins (the writer's fundedIds makes duplicates a
 * contract violation anyway); `skipped` counts rows that failed validation.
 */
export function parseSelectorPicks(text: string): { picks: SelectorPickRow[]; skipped: number } {
  const picks: SelectorPickRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { skipped++; continue; }
    if (!isRecord(row)) { skipped++; continue; }
    const at = typeof row['at'] === 'string' ? Date.parse(row['at']) : NaN;
    const id = row['id'];
    const repo = typeof row['repo'] === 'string' ? fieldText(row['repo']) : '';
    const jobType = typeof row['jobType'] === 'string' ? fieldText(row['jobType']) : '';
    if (!Number.isFinite(at) || typeof id !== 'string' || !PICK_ID_RE.test(id)
      || repo === '' || jobType === '' || seen.has(id)) { skipped++; continue; }
    seen.add(id);
    picks.push({
      atMs: at,
      utcDay: utcDayOf(at),
      id,
      repo,
      jobType,
      mergeRate: finiteNum(row['mergeRate']),
      predictedValue: finiteNum(row['predictedValue']),
    });
  }
  return { picks, skipped };
}

// ---------------------------------------------------------------------------
// Queue-side evidence
// ---------------------------------------------------------------------------

/** Ids → market-queue status, from queue.v1.json's jobs[] (null status = present, status unreadable). */
export interface QueueEvidence {
  /** Job ids with a live (non-terminal) market-queue row. */
  marketLive: Set<string>;
  /** Job ids whose market row ended DROPPED or RETIRED. */
  marketDropped: Set<string>;
  /** Job ids named by any router-queue.md line (any status). */
  proposed: Set<string>;
  /** Job ids on live (non-parked) ready.tsv rows. */
  readyLive: Set<string>;
  /** Job ids on parked ready.tsv rows only. */
  readyParked: Set<string>;
  /** Job ids archived in queue/dropped.tsv. */
  dropped: Set<string>;
  /** True when a source that could have held the pick was degraded — absence is then unproven. */
  degraded: boolean;
}

const RQ_TOKEN_RE = /\bRQ-[A-Za-z0-9][A-Za-z0-9._-]{0,95}\b/g;

/** Extract every RQ-* id token a markdown proposal doc names, any status. */
function markdownIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(RQ_TOKEN_RE)) ids.add(match[0]);
  return ids;
}

const MARKET_DROPPED_STATUSES = new Set(['DROPPED', 'RETIRED']);

/**
 * Pure: fold queue.v1.json text into per-id market statuses. Only the
 * jobs[] array's id/status fields are read; a document that does not parse
 * returns null so the caller can mark the market evidence degraded rather
 * than treating an unreadable store as an empty one. A valid document
 * without a jobs array yields an empty map.
 */
export function parseQueueV1Jobs(text: string): Map<string, string | null> | null {
  const out = new Map<string, string | null>();
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isRecord(doc)) return null;
  if (!Array.isArray(doc['jobs'])) return out;
  for (const job of doc['jobs']) {
    if (!isRecord(job)) continue;
    const id = job['id'];
    if (typeof id !== 'string' || !PICK_ID_RE.test(id)) continue;
    const status = typeof job['status'] === 'string' ? job['status'].trim().toUpperCase() : null;
    out.set(id, status);
  }
  return out;
}

// ---------------------------------------------------------------------------
// jobs.jsonl outcome tallies (settled pick ids only)
// ---------------------------------------------------------------------------

/** Recorded outcome tallies for one pick's job inside the window. */
export interface PickJobTally {
  launches: number;
  finishes: number;
  /** Finish rows carrying empty evidence (empty:true or EMPTY_DONE). */
  finishEmpty: number;
  /** Publish rows claiming a PR (class 'pr' or carrying a PR url). */
  prs: number;
  /** Publish rows whose class is 'empty' — publish found nothing to ship. */
  publishEmpty: number;
  /** Publish rows whose class starts with 'abort'. */
  aborts: number;
  /** Resolved outcome states: MERGED verdicts, CLOSED verdicts and every other resolved phase. */
  merged: number;
  closed: number;
  /** Outcome rows carrying phase 'OPEN' — a PR opened, still awaiting its verdict. */
  openPhases: number;
  /** Resolved phases that are neither MERGED, CLOSED nor OPEN. */
  resolvedOther: number;
}

const emptyTally = (): PickJobTally => ({
  launches: 0, finishes: 0, finishEmpty: 0, prs: 0, publishEmpty: 0,
  aborts: 0, merged: 0, closed: 0, openPhases: 0, resolvedOther: 0,
});

/**
 * Pure: fold one jobs-ledger tail into per-job outcome tallies for the
 * given pick ids. Only rows inside the window count; node-pool producer
 * schemas, malformed lines, unsafe job ids and undated rows are skipped,
 * never guessed. The dialect accessors are the shared ones the sibling
 * folds use.
 */
export function foldPickJobOutcomes(
  text: string,
  pickIds: ReadonlySet<string>,
  nowMs: number,
  windowMs: number = SELECTOR_PICKS_WINDOW_MS,
): Map<string, PickJobTally> {
  const out = new Map<string, PickJobTally>();
  const since = nowMs - windowMs;
  const until = nowMs + SELECTOR_PICK_SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('RQ-')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || isNodePoolLedgerRow(row)) continue;
    const job = ledgerJobId(row);
    if (job === null || !pickIds.has(job)) continue;
    const phase = ledgerPhase(row);
    const atMs = ledgerEventTs(row, phase);
    if (atMs === null || atMs < since || atMs > until) continue;
    const event = ledgerLifecycleEvent(row, phase);
    let tally = out.get(job);
    if (tally === undefined) {
      tally = emptyTally();
      out.set(job, tally);
    }
    if (event === 'launch') {
      tally.launches += 1;
      continue;
    }
    if (event === 'finish') {
      tally.finishes += 1;
      if (row['empty'] === true || ledgerStateTokens(row).includes('EMPTY_DONE')) tally.finishEmpty += 1;
    } else if (event === 'publish') {
      const kind = typeof row['class'] === 'string' ? row['class'].trim().toLowerCase() : '';
      if (kind === 'empty') tally.publishEmpty += 1;
      else if (kind.startsWith('abort')) tally.aborts += 1;
      else if (kind === 'pr' || ((kind === '' || kind === 'unknown') && ledgerPrUrl(row) !== null)) tally.prs += 1;
    }
    const state = ledgerOutcomeState(row, event, phase);
    if (state === 'MERGED') tally.merged += 1;
    else if (state === 'CLOSED') tally.closed += 1;
    else if (state === 'OPEN') tally.openPhases += 1;
    else if (state !== null) tally.resolvedOther += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** Per-cell adverse-pick track inside the window. */
interface PickTrack {
  picks: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Example pick ids, bounded — must already match PICK_ID_RE. */
  ids: string[];
  /** Recorded mergeRate values, for prompt context (bounded count). */
  mergeRates: number[];
}

const newTrack = (): PickTrack => ({
  picks: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  ids: [],
  mergeRates: [],
});

function trackPick(track: PickTrack, pick: SelectorPickRow): void {
  track.picks += 1;
  track.days.add(pick.utcDay);
  track.firstMs = Math.min(track.firstMs, pick.atMs);
  track.lastMs = Math.max(track.lastMs, pick.atMs);
  if (track.ids.length < PROMPT_EXAMPLES_MAX && !track.ids.includes(pick.id)) track.ids.push(pick.id);
  if (pick.mergeRate !== null && track.mergeRates.length < 50) track.mergeRates.push(pick.mergeRate);
}

const meetsBar = (track: PickTrack): boolean =>
  track.picks >= SELECTOR_PICK_MIN_ROWS && track.days.size >= SELECTOR_PICK_MIN_DAYS;

/** Resolved outcome states a settled pick can land in. */
export type PickState =
  | 'merged' | 'in-flight' | 'unmerged' | 'empty'
  | 'dropped' | 'never-proposed' | 'marketed' | 'proposed' | 'queued' | 'parked' | 'unknown';

/**
 * Pure: resolve one settled pick's state from its jobs tally and the
 * queue-side evidence. Jobs-ledger evidence wins first — a launched job's
 * outcome is the strongest signal; then explicit kills (drop archive,
 * market DROPPED/RETIRED); then any positive pipeline presence skips the
 * pick; 'never-proposed' requires every source readable-or-empty, and a
 * degraded source forces 'unknown' instead of a false absence claim.
 */
export function pickState(
  pick: SelectorPickRow,
  tally: PickJobTally | undefined,
  evidence: QueueEvidence,
): PickState {
  if (tally !== undefined) {
    if (tally.merged > 0) return 'merged';
    // A closed or otherwise resolved non-merge verdict is terminal; an
    // open PR or publish claim is still in flight.
    if (tally.closed > 0 || tally.resolvedOther > 0) return 'unmerged';
    if (tally.openPhases > 0 || tally.prs > 0) return 'in-flight';
    const produced = tally.finishes - tally.finishEmpty;
    if (tally.finishEmpty + tally.publishEmpty > 0 && produced === 0) return 'empty';
    if (tally.finishes > 0) return 'unmerged';
    return tally.launches > 0 ? 'in-flight' : 'unknown';
  }
  if (evidence.dropped.has(pick.id)) return 'dropped';
  if (evidence.marketDropped.has(pick.id)) return 'dropped';
  if (evidence.marketLive.has(pick.id)) return 'marketed';
  if (evidence.proposed.has(pick.id)) return 'proposed';
  if (evidence.readyLive.has(pick.id)) return 'queued';
  if (evidence.readyParked.has(pick.id)) return 'parked';
  return evidence.degraded ? 'unknown' : 'never-proposed';
}

/** The fold's output: adverse cells plus context tallies for the prompt. */
export interface SelectorPicksFold {
  /** repo → 'never-proposed' picks (funded, no evidence anywhere). */
  neverProposed: Map<string, PickTrack>;
  /** repo → 'dropped' picks (queued or marketed, then killed). */
  dropped: Map<string, PickTrack>;
  /** repo\njobType → 'unmerged' picks (ran to a verdict, no merge). */
  unmerged: Map<string, PickTrack>;
  /** repo\njobType → 'empty' picks (ran, produced no change). */
  empty: Map<string, PickTrack>;
  /** Settled picks seen (all states) — context for prompts. */
  settled: number;
  /** Picks still inside the settle window — pending, never evidence. */
  pending: number;
  /** Picks outside the window or failing validation-adjacent checks. */
  outOfWindow: number;
}

const cellKey = (repo: string, jobType: string): string => `${repo}\n${jobType}`;

const trackInto = (map: Map<string, PickTrack>, key: string, pick: SelectorPickRow): void => {
  let track = map.get(key);
  if (track === undefined) {
    track = newTrack();
    map.set(key, track);
  }
  trackPick(track, pick);
};

/**
 * Pure: fold validated picks + evidence into the adverse cells. Picks
 * inside the settle window or outside the evidence window contribute
 * nothing; healthy and in-flight states count as context only.
 */
export function foldSelectorPicks(
  picks: readonly SelectorPickRow[],
  jobs: ReadonlyMap<string, PickJobTally>,
  evidence: QueueEvidence,
  nowMs: number,
): SelectorPicksFold {
  const fold: SelectorPicksFold = {
    neverProposed: new Map(), dropped: new Map(), unmerged: new Map(), empty: new Map(),
    settled: 0, pending: 0, outOfWindow: 0,
  };
  const windowStart = nowMs - SELECTOR_PICKS_WINDOW_MS;
  for (const pick of picks) {
    if (pick.atMs < windowStart || pick.atMs > nowMs + SELECTOR_PICK_SKEW_MS) { fold.outOfWindow += 1; continue; }
    if (pick.atMs > nowMs - SELECTOR_PICK_SETTLE_MS) { fold.pending += 1; continue; }
    fold.settled += 1;
    const state = pickState(pick, jobs.get(pick.id), evidence);
    if (state === 'never-proposed') trackInto(fold.neverProposed, pick.repo, pick);
    else if (state === 'dropped') trackInto(fold.dropped, pick.repo, pick);
    else if (state === 'unmerged') trackInto(fold.unmerged, cellKey(pick.repo, pick.jobType), pick);
    else if (state === 'empty') trackInto(fold.empty, cellKey(pick.repo, pick.jobType), pick);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface SelectorPicksItemsOptions {
  /** Backlog target in owner/name form; the journals describe the fleet repo only. */
  repo: string;
  /** Runs dir holding selector/, queue/ and metrics/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SELECTOR_PICKS_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and settle bound (default: now). */
  now?: Date;
}

const WINDOW_DAYS = Math.round(SELECTOR_PICKS_WINDOW_MS / 86_400_000);
const SETTLE_HOURS = Math.round(SELECTOR_PICK_SETTLE_MS / 3_600_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the picks reached the queue under different evidence since, every recorded attempt landed its PR and merged or the PR closed as legitimately superseded, the drops were deliberate operator or policy acts, or the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is selector/picks.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the record `phm select` appends per funded pick ({at, rank, id, repo, jobType, score, predictedValue, mergeRate, minutes, usage, basis}) — joined against every place the contract\'s "a planner appends the lines to the queue" step would leave a trace: queue/router-queue.md (the proposal doc restock turns into launch rows), queue/ready.tsv and its PARKED-* rows (the dispatcher\'s live launch queue), queue/dropped.tsv (the `phm queue order drop` archive), queue/queue.v1.json (the `phm queue` work-market store) and metrics/jobs.jsonl (the dispatchd attempt dialect — launch, finish, publish and outcome rows keyed by the pick\'s job id). The picks journal\'s only other reader is fundedIds, which refuses to fund an id twice, forever.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The picks.jsonl tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: PickTrack): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const examplesText = (track: PickTrack): string =>
  track.ids.length === 0 ? '' : ` Example pick id(s): ${track.ids.map((id) => `\`${id}\``).join(', ')}.`;

const mergeRateText = (track: PickTrack): string => {
  if (track.mergeRates.length === 0) return '';
  const mean = track.mergeRates.reduce((a, b) => a + b, 0) / track.mergeRates.length;
  return ` The selector's recorded mergeRate prior on these picks averaged ${mean.toFixed(2)}.`;
};

function neverProposedPrompt(repo: string, track: PickTrack, truncated: boolean): string {
  return [
    `The selector keeps funding picks that never reach the queue — ${track.picks} pick(s) for ${repo} inside the window left no trace in any queue or job ledger, and picks.jsonl now refuses their ids forever.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window the journal recorded ${track.picks} settled pick(s) for ${repo} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), each older than the ${SETTLE_HOURS}-hour settle bound.${examplesText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each of these picks was funded — its id written to picks.jsonl and its READY line printed and announced on the bus — but no router-queue.md line, ready.tsv row, queue.v1.json job, dropped.tsv archive row or jobs.jsonl lifecycle row ever named it. The contract leaves the append to "a planner": the selector.picks envelope has a one-hour TTL and nothing verifies the planner acted, while fundedIds makes every unconsumed pick permanently unfundable — the candidate's work is silently lost and the selector's own accounting still counts it as funded. Find where planner passes are supposed to consume selector.picks (or selector.log's READY lines): whether any pass appends them to router-queue.md, whether the envelope is read at all, and whether picks.jsonl dedupe should expire or the append should be automated in this repository (src/core/routing/selector.ts, src/cli/select.ts, the bus/planner consumers). If the picks were appended under different ids or the evidence sources were degraded — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function droppedPrompt(repo: string, track: PickTrack, truncated: boolean): string {
  return [
    `Selector-funded picks are reaching the queue and then being dropped — ${track.picks} pick(s) for ${repo} inside the window ended in the drop archive or a terminal market status.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window the journal recorded ${track.picks} settled pick(s) for ${repo} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), each older than the ${SETTLE_HOURS}-hour settle bound.${examplesText(track)}${mergeRateText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each of these picks left the funding journal, reached the queue (a dropped.tsv archive row or a queue.v1.json DROPPED/RETIRED status) and was then removed before or without merging — funded work the fleet paid selection effort for and then killed. Join the named ids to queue/dropped.tsv rows, dispatch-events.log QUEUE_DROPPED lines and 'phm queue order' history to learn who dropped them and why: legitimate kills (duplicate, superseded, owner hold) are the machinery working, but a class of picks the fleet keeps funding and then dropping means the selector's candidate pool or the drop path's evidence disagrees — stale friction items, already-done work, or a drop rule that misfires on RQ-FRICTION/RQ-SUPPLY ids. Fix what lives in this repository — the selector's candidate filters, the friction ledger's open-item hygiene, the queue drop callers — and treat dispatchd, restock and publish machinery as pinned ops. If the drops were deliberate and the window rolled — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unmergedPrompt(repo: string, jobType: string, track: PickTrack, truncated: boolean): string {
  return [
    `Selector-funded ${jobType} picks for ${repo} run to a verdict but never merge — ${track.picks} pick(s) inside the window finished, closed or resolved with no MERGED outcome.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window the journal recorded ${track.picks} settled pick(s) for ${repo}/${jobType} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), each older than the ${SETTLE_HOURS}-hour settle bound.${examplesText(track)}${mergeRateText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each of these picks became a job that reached a finish, close or resolved outcome in metrics/jobs.jsonl with zero MERGED rows — the selector's predicted mergeRate did not materialize for this repo/jobType cell. Join the named ids to their jobs.jsonl rows ('phm jobs yield', 'phm jobs empty', 'phm fleet outcomes') and their PRs to classify the miss: PRs closed unmerged (superseded is legitimate; review or CI rejection is not), finishes that produced work which never published, or candidates that were already satisfied — the last is the selector funding stale friction items. The fix lives in this repository's candidate hygiene (selector.ts, the friction ledger's open-item lifecycle, queuegen/backlog dedupe), not in the pinned dispatcher. If the jobs merged under evidence this fold could not see, or the window rolled — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function emptyPrompt(repo: string, jobType: string, track: PickTrack, truncated: boolean): string {
  return [
    `Selector-funded ${jobType} picks for ${repo} finish EMPTY — the jobs launch and produce no change.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window the journal recorded ${track.picks} settled pick(s) for ${repo}/${jobType} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), each older than the ${SETTLE_HOURS}-hour settle bound.${examplesText(track)}${mergeRateText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each of these picks became a job whose every recorded finish or publish ended with no change — empty:true finishes, EMPTY_DONE states or publish class 'empty' — and no PR. For selector picks this usually means the candidate was already satisfied: a friction-ledger item whose underlying problem was fixed by other work still mints an RQ-FRICTION candidate, or a candidates.jsonl row describes work master already contains. Check the named jobs' prompts against current master, the friction ledger's open items for the same evidence, and the empty-run detectors (src/core/improve/empty-tag-backlog.ts, src/core/queue) — the fix is earlier filtering so already-done work never gets funded, not the jobs themselves. If the empties were legitimate no-change reports — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

interface CellEntry {
  kind: 'never-proposed' | 'dropped' | 'unmerged' | 'empty';
  /** Cell key inside its map (repo, or repo\njobType). */
  mapKey: string;
  track: PickTrack;
  /** [repo, jobType?] for prompt composition. */
  parts: [string, string?];
}

function sortedCells(map: Map<string, PickTrack>): Array<{ key: string; track: PickTrack }> {
  return [...map.entries()]
    .map(([key, track]) => ({ key, track }))
    .sort((a, b) => b.track.picks - a.track.picks || a.key.localeCompare(b.key));
}

/**
 * Backlog items for the selector picks journal's recurring adverse
 * evidence, in a fixed cell order (pipeline losses first, then outcome
 * misses). Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function selectorPicksBacklogItems(opts: SelectorPicksItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const nowMs = (opts.now ?? new Date()).getTime();

    const picksTail = await readLedgerTail(join(runsDir, 'selector', 'picks.jsonl'), SELECTOR_PICKS_TAIL_BYTES);
    if (picksTail.state !== 'read') return [];
    const { picks } = parseSelectorPicks(picksTail.text);
    if (picks.length === 0) return [];

    // Queue-side evidence: every bounded read is independent — a degraded
    // source marks evidence.degraded so 'never-proposed' stays unproven.
    const evidence: QueueEvidence = {
      marketLive: new Set(), marketDropped: new Set(), proposed: new Set(),
      readyLive: new Set(), readyParked: new Set(), dropped: new Set(),
      degraded: false,
    };

    const [queueV1, routerQueue, droppedRead, jobsTail] = await Promise.all([
      readSource(join(runsDir, 'queue', 'queue.v1.json'), QUEUE_V1_MAX_BYTES, false),
      readSource(join(runsDir, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES, false),
      readSource(join(runsDir, 'queue', 'dropped.tsv'), DROPPED_MAX_BYTES, true),
      readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE)),
    ]);
    if (queueV1.state === 'degraded') evidence.degraded = true;
    else if (queueV1.state === 'healthy') {
      const market = parseQueueV1Jobs(queueV1.text);
      if (market === null) evidence.degraded = true;
      else {
        for (const [id, status] of market) {
          if (status !== null && MARKET_DROPPED_STATUSES.has(status)) evidence.marketDropped.add(id);
          else evidence.marketLive.add(id);
        }
      }
    }
    if (routerQueue.state === 'degraded') evidence.degraded = true;
    else if (routerQueue.state === 'healthy') {
      for (const id of markdownIds(routerQueue.text)) evidence.proposed.add(id);
    }
    if (droppedRead.state === 'degraded') evidence.degraded = true;
    else if (droppedRead.state === 'healthy') {
      for (const row of parseReadyRows(droppedRead.text)) {
        if (PICK_ID_RE.test(row.id)) evidence.dropped.add(row.id);
      }
    }
    if (jobsTail.state === 'unreadable' || jobsTail.state === 'not-file') evidence.degraded = true;

    try {
      const readyText = await readReadyText(join(runsDir, 'queue', 'ready.tsv'));
      for (const row of parseReadyRows(readyText)) {
        if (!PICK_ID_RE.test(row.id)) continue;
        if (parked(row)) evidence.readyParked.add(row.id);
        else evidence.readyLive.add(row.id);
      }
    } catch (error) {
      // ENOENT means no launch queue exists yet — empty evidence, not
      // degradation. Any other failure leaves 'queued' unproven.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') evidence.degraded = true;
    }

    // Only settled in-window picks can resolve; fold jobs evidence for
    // exactly those ids so the ledger tail stays a bounded scan.
    const windowStart = nowMs - SELECTOR_PICKS_WINDOW_MS;
    const settledIds = new Set<string>();
    for (const pick of picks) {
      if (pick.atMs >= windowStart && pick.atMs <= nowMs + SELECTOR_PICK_SKEW_MS
        && pick.atMs <= nowMs - SELECTOR_PICK_SETTLE_MS) settledIds.add(pick.id);
    }
    const jobs = settledIds.size === 0 || jobsTail.state !== 'read'
      ? new Map<string, PickJobTally>()
      : foldPickJobOutcomes(jobsTail.text, settledIds, nowMs);
    const jobsLowerBound = jobsTail.state === 'read' && jobsTail.truncated;

    const fold = foldSelectorPicks(picks, jobs, evidence, nowMs);
    const limit = Math.max(1, Math.min(opts.limit ?? SELECTOR_PICKS_MAX_ITEMS, SELECTOR_PICKS_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    const push = (kind: CellEntry['kind'], key: string, title: string, prompt: string): void => {
      if (items.length >= limit) return;
      const hash = createHash('sha256').update(`selector-picks:${kind}:${repo.trim().toLowerCase()}:${key}`).digest('hex').slice(0, 16);
      items.push({
        id: `selectorpick-${kind}-${hash}`,
        title: title.slice(0, MAX_TITLE_CHARS),
        prompt,
        area: 'selector-picks',
        priority: 3,
        ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
      });
    };

    const cells: CellEntry[] = [
      ...sortedCells(fold.neverProposed)
        .filter(({ track }) => meetsBar(track))
        .map(({ key, track }) => ({ kind: 'never-proposed' as const, mapKey: key, track, parts: [key] as [string] })),
      ...sortedCells(fold.dropped)
        .filter(({ track }) => meetsBar(track))
        .map(({ key, track }) => ({ kind: 'dropped' as const, mapKey: key, track, parts: [key] as [string] })),
      ...sortedCells(fold.unmerged)
        .filter(({ track }) => meetsBar(track))
        .map(({ key, track }) => {
          const [r, jt] = key.split('\n');
          return { kind: 'unmerged' as const, mapKey: key, track, parts: [r ?? '', jt ?? ''] as [string, string] };
        }),
      ...sortedCells(fold.empty)
        .filter(({ track }) => meetsBar(track))
        .map(({ key, track }) => {
          const [r, jt] = key.split('\n');
          return { kind: 'empty' as const, mapKey: key, track, parts: [r ?? '', jt ?? ''] as [string, string] };
        }),
    ];
    // Pipeline losses first, then outcome misses; within a kind the sorted
    // cells already order by recorded picks.
    cells.sort((a, b) => {
      const order = { 'never-proposed': 0, dropped: 1, unmerged: 2, empty: 3 } as const;
      return order[a.kind] - order[b.kind] || b.track.picks - a.track.picks || a.mapKey.localeCompare(b.mapKey);
    });

    for (const cell of cells) {
      const [cellRepo, cellJobType] = cell.parts;
      const titleRepo = cellRepo === '' ? 'unknown' : cellRepo;
      if (cell.kind === 'never-proposed') {
        push(cell.kind, cell.mapKey,
          `Selector-funded picks for ${titleRepo} never reached the queue`,
          neverProposedPrompt(titleRepo, cell.track, picksTail.truncated));
      } else if (cell.kind === 'dropped') {
        push(cell.kind, cell.mapKey,
          `Selector-funded picks for ${titleRepo} reach the queue then get dropped`,
          droppedPrompt(titleRepo, cell.track, picksTail.truncated));
      } else if (cell.kind === 'unmerged') {
        push(cell.kind, cell.mapKey,
          `Selector-funded ${cellJobType} picks for ${titleRepo} run but never merge`,
          unmergedPrompt(titleRepo, cellJobType ?? '', cell.track, picksTail.truncated || jobsLowerBound));
      } else {
        push(cell.kind, cell.mapKey,
          `Selector-funded ${cellJobType} picks for ${titleRepo} finish empty`,
          emptyPrompt(titleRepo, cellJobType ?? '', cell.track, picksTail.truncated || jobsLowerBound));
      }
    }
    return items;
  } catch {
    return [];
  }
}
