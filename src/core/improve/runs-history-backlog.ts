/**
 * Fleet runs-history journal recurring evidence → self-improvement backlog items.
 *
 * The fleet-runs API samples what the lanes actually held over time:
 * GET /api/verse/runs-history (src/core/verse/runs-history-api.ts) offers
 * sampleIfDue before every read, and collectRunsSample
 * (src/core/fleet/runs-history.ts) appends one RunsSample line to
 * runs-history.jsonl — {at, lanes:[{lane, running, target, queued, held}],
 * workers, leaders, paused} — at most once per minute while the API is
 * read. The file lives beside the fleet state, never inside the runs
 * directory: $ASHLR_RUNS_HISTORY_FILE (absolute) wins, else
 * $ASHLR_HOME/fleet/runs-history.jsonl, else ~/.ashlr/fleet/. Appends
 * past 2 MiB trigger a compaction keeping only lines provably newer
 * than seven days; reads serve at most the newest 2 MiB of a larger
 * file. Because sampling is on-read, the series honestly covers only
 * watched time — gaps are expected, never backfilled.
 *
 * Until now the file's only readers were point-in-time or display
 * surfaces: the API's own windowed response, the Command capacity
 * panes, lane-streaks and stall-window projections — all reports
 * someone had to open. A lane that kept queued work it never filled,
 * a lane held while its queue waited, or a fleet paused for days with
 * work outstanding never became work. runsHistoryBacklogItems carries
 * the same journal into discoverBacklog:
 *
 *  - 'lane-starved' cells recurring per lane: samples where the lane
 *    recorded queued > 0 while it was not filling its own target —
 *    running < target, or target === 0 with a backlog parked on a
 *    lane scaled to zero. The prompt splits the two causes.
 *  - 'lane-held' cells recurring per lane: held === true samples with
 *    queued > 0 — a lane hold blocking recorded work.
 *  - 'fleet-paused': paused === true samples across days while at
 *    least two of them recorded queued work — dispatch suspended
 *    while the queue waited.
 *  - 'corrupt-lines': three or more non-blank lines inside the
 *    retained tail fail the writer's own sample contract — torn
 *    writes, foreign appends or shape drift the readers skip
 *    silently.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail at 4 MiB — past the file's own 2 MiB compaction
 *    bound, so the retained tail is everything the store keeps;
 *    nothing is written and no process, file tree or network is
 *    touched. Missing, non-file or unreadable evidence yields no
 *    items.
 *  - The journal describes this install's lanes and carries no
 *    repository column, so like the sibling fleet-evidence feeds,
 *    items emit only when the backlog's repo name is the fleet's
 *    own; another repository inherits nothing.
 *  - Rows count only under the writer's contract: the same checks
 *    parseRunsSample in src/core/fleet/runs-history.ts applies —
 *    ISO-parseable `at` inside 64 chars, lanes a bounded array of
 *    {lane ≤ 80 chars, running/target/queued safe integers ≥ 0,
 *    held boolean}, workers/leaders null-or-count and paused
 *    null-or-boolean. Malformed lines are skipped and counted,
 *    never guessed; a truncated tail still folds the retained rows
 *    with the prompts stating the counts as lower bounds.
 *  - The analysis window mirrors the store's own bounds: samples
 *    older than the seven-day retention or stamped past the
 *    one-minute future-skew tolerance contribute nothing, so a
 *    stale pre-compaction row cannot fake recurrence and a
 *    future-stamped row cannot fake activity.
 *  - Recurring means sampled across days: lane cells emit only at
 *    RUNS_HISTORY_MIN_ADVERSE recorded adverse samples across
 *    RUNS_HISTORY_MIN_DAYS distinct UTC days, the fleet's
 *    RECURRING_FAILURES convention applied to occupancy samples —
 *    a lane ramping up for one afternoon never queues a session.
 *    'fleet-paused' additionally needs recorded queued work during
 *    the pause; 'corrupt-lines' needs three contract failures so
 *    one torn tail fragment never emits.
 *  - workers/leaders stay context, never cells: they are counts of
 *    fleet processes on the sampled host only, so a healthy zero on
 *    a host that legitimately runs no local workers is ambiguous —
 *    quoting them as evidence would claim more than the journal
 *    proves.
 *  - Dedup is downstream. Item ids hash the cell kind + lane +
 *    repo (never the counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    lane that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, lane names come from validated rows,
 *    and the brief names the journal, the sampler, the store
 *    contract and the live surfaces with the usual no-change escape
 *    when the window no longer reproduces or the state was
 *    deliberate.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the lane set is bounded by the fleet's lane table. */
export const RUNS_HISTORY_MAX_ITEMS = 8;
const RUNS_HISTORY_ITEM_HARD_MAX = 25;
/** Recorded adverse samples one lane cell needs inside the window. */
export const RUNS_HISTORY_MIN_ADVERSE = 8;
/** Paused samples one fleet-paused cell needs inside the window. */
export const RUNS_HISTORY_MIN_PAUSED = 8;
/** Distinct UTC days every recurring cell needs inside the window. */
export const RUNS_HISTORY_MIN_DAYS = 2;
/** Paused samples with queued work the fleet-paused cell needs. */
export const RUNS_HISTORY_MIN_PAUSED_QUEUED = 2;
/** Contract-failing lines one corrupt-lines cell needs inside the retained tail. */
export const RUNS_HISTORY_CORRUPT_MIN = 3;
/**
 * Analysis window: the store's own retention horizon — compaction keeps
 * only lines newer than seven days and readRunsHistory serves at most
 * 168 hours — plus the sibling feeds' one-minute future-skew tolerance.
 */
export const RUNS_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RUNS_HISTORY_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail for the journal: the file compacts past 2 MiB and the
 * widest read serves the newest 2 MiB of 4 MiB, so 4 MiB sees every
 * row the store itself would ever return.
 */
export const RUNS_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
/** The journal's file name under <ashlr-home>/fleet/, the writer's own layout. */
const RUNS_HISTORY_FILE_NAME = 'runs-history.jsonl';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: runs evidence is this install's lanes. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();
/** The producer's shape bounds (MAX_LANES, MAX_LANE_CHARS, MAX_AT_CHARS in runs-history.ts), inlined so this reader validates the persisted contract without importing the sampler's module graph. */
const MAX_LANES_PER_SAMPLE = 64;
const MAX_LANE_CHARS = 80;
const MAX_AT_CHARS = 64;

export interface RunsHistoryItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: the writer's own resolution — ASHLR_RUNS_HISTORY_FILE absolute, else <ashlr-home>/fleet/runs-history.jsonl). */
  journalPath?: string;
  /** Home for the default journal dir (default: env-aware resolution like runsHistoryFile()). */
  homeDir?: string;
  /** Most items one call emits (default RUNS_HISTORY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated lane row inside a sample. */
export interface RunsHistoryFoldLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
}

/** One validated sample inside the analysis window. */
export interface RunsHistoryFoldSample {
  atMs: number;
  utcDay: string;
  lanes: RunsHistoryFoldLane[];
  workers: number | null;
  leaders: number | null;
  paused: boolean | null;
}

/** The journal parse result: in-window samples plus the contract-failure count. */
export interface RunsHistoryParse {
  samples: RunsHistoryFoldSample[];
  /** Non-blank lines the sample contract rejected inside the retained tail. */
  corrupt: number;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCountOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/**
 * Pure: validate one journal line against the writer's own contract —
 * the same checks parseRunsSample in src/core/fleet/runs-history.ts
 * applies, kept local so this feed's import closure stays inside the
 * improve subtree plus the shared ledger tail reader. Returns null for
 * anything off-contract; callers count it, never guess.
 */
export function parseRunsHistorySample(value: unknown): Omit<RunsHistoryFoldSample, 'utcDay'> | null {
  if (!isRecord(value)) return null;
  const at = value['at'];
  if (typeof at !== 'string' || at.length > MAX_AT_CHARS || !Number.isFinite(Date.parse(at))) return null;
  const lanes = value['lanes'];
  if (!Array.isArray(lanes) || lanes.length > MAX_LANES_PER_SAMPLE) return null;
  const clean: RunsHistoryFoldLane[] = [];
  for (const raw of lanes) {
    if (!isRecord(raw)) return null;
    const { lane, running, target, queued, held } = raw;
    if (typeof lane !== 'string' || lane.length === 0 || lane.length > MAX_LANE_CHARS ||
        typeof running !== 'number' || !Number.isSafeInteger(running) || running < 0 ||
        typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 ||
        typeof queued !== 'number' || !Number.isSafeInteger(queued) || queued < 0 ||
        typeof held !== 'boolean') return null;
    clean.push({ lane, running, target, queued, held });
  }
  const { workers, leaders, paused } = value;
  if (!isCountOrNull(workers) || !isCountOrNull(leaders) || !(paused === null || typeof paused === 'boolean')) return null;
  return { atMs: Date.parse(at), lanes: clean, workers, leaders, paused };
}

/**
 * Pure: parse journal text into validated in-window samples plus a
 * contract-failure count. Rows outside the retention window or past
 * the future skew parse fine but fold nowhere — they are neither
 * evidence nor corruption.
 */
export function parseRunsHistoryJournal(
  text: string,
  nowMs: number,
): RunsHistoryParse {
  const samples: RunsHistoryFoldSample[] = [];
  let corrupt = 0;
  const windowStart = nowMs - RUNS_HISTORY_WINDOW_MS;
  const until = nowMs + RUNS_HISTORY_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      corrupt += 1;
      continue;
    }
    const sample = parseRunsHistorySample(value);
    if (sample === null) {
      corrupt += 1;
      continue;
    }
    if (sample.atMs < windowStart || sample.atMs > until) continue;
    samples.push({ ...sample, utcDay: utcDayOf(sample.atMs) });
  }
  return { samples, corrupt };
}

/** One lane's in-window occupancy evidence. */
export interface RunsHistoryLaneFold {
  lane: string;
  /** In-window samples that carried this lane. */
  samples: number;
  /** Samples with queued > 0 while not filling target (target === 0 or running < target). */
  starved: number;
  /** Distinct UTC days holding at least one starved sample. */
  starvedDays: Set<string>;
  /** Starved samples with target > 0 and running < target. */
  underTarget: number;
  /** Starved samples with target === 0 and queued > 0. */
  zeroTarget: number;
  /** Samples with held === true and queued > 0. */
  held: number;
  /** Distinct UTC days holding at least one held-with-queue sample. */
  heldDays: Set<string>;
  /** Largest queued count any of the lane's samples recorded. */
  maxQueued: number;
  /** UTC day of the lane's first in-window sample. */
  firstDay: string;
  /** Newest sample instant carrying the lane. */
  lastMs: number;
}

/** The fold's output. */
export interface RunsHistoryFold {
  /** In-window validated samples. */
  samples: number;
  /** Contract-failing lines inside the retained tail. */
  corrupt: number;
  /** Newest valid in-window sample instant, or null when none parsed. */
  newestMs: number | null;
  /** Per-lane occupancy evidence, keyed by lane name. */
  lanes: Map<string, RunsHistoryLaneFold>;
  /** paused === true samples inside the window. */
  pausedSamples: number;
  /** Distinct UTC days holding at least one paused sample. */
  pausedDays: Set<string>;
  /** Paused samples that also recorded queued work. */
  pausedWithQueue: number;
}

/**
 * Pure: fold validated samples into per-lane and fleet-wide evidence.
 * A lane named twice in one sample folds its first row only — the
 * producer emits one row per lane and a duplicate is contract-valid
 * foreign shape this fold refuses to double-count. Starved means the
 * lane recorded a backlog it was not filling: queued > 0 while
 * running < target, or queued > 0 parked on a lane whose target is
 * zero. Held-with-queue means the lane's hold flag stood while work
 * waited. pausedWithQueue requires at least one lane row with
 * queued > 0 in the same sample — a paused fleet with an empty queue
 * blocks nothing.
 */
export function foldRunsHistorySamples(
  samples: readonly RunsHistoryFoldSample[],
  corrupt: number,
): RunsHistoryFold {
  const fold: RunsHistoryFold = {
    samples: samples.length,
    corrupt,
    newestMs: null,
    lanes: new Map(),
    pausedSamples: 0,
    pausedDays: new Set(),
    pausedWithQueue: 0,
  };
  for (const sample of samples) {
    if (fold.newestMs === null || sample.atMs > fold.newestMs) fold.newestMs = sample.atMs;
    if (sample.paused === true) {
      fold.pausedSamples += 1;
      fold.pausedDays.add(sample.utcDay);
      if (sample.lanes.some((lane) => lane.queued > 0)) fold.pausedWithQueue += 1;
    }
    const seen = new Set<string>();
    for (const lane of sample.lanes) {
      if (seen.has(lane.lane)) continue;
      seen.add(lane.lane);
      let cell = fold.lanes.get(lane.lane);
      if (cell === undefined) {
        cell = {
          lane: lane.lane,
          samples: 0,
          starved: 0,
          starvedDays: new Set(),
          underTarget: 0,
          zeroTarget: 0,
          held: 0,
          heldDays: new Set(),
          maxQueued: 0,
          firstDay: sample.utcDay,
          lastMs: sample.atMs,
        };
        fold.lanes.set(lane.lane, cell);
      }
      cell.samples += 1;
      if (sample.utcDay < cell.firstDay) cell.firstDay = sample.utcDay;
      if (sample.atMs > cell.lastMs) cell.lastMs = sample.atMs;
      if (lane.queued > cell.maxQueued) cell.maxQueued = lane.queued;
      if (lane.queued > 0 && (lane.target === 0 || lane.running < lane.target)) {
        cell.starved += 1;
        cell.starvedDays.add(sample.utcDay);
        if (lane.target === 0) cell.zeroTarget += 1;
        else cell.underTarget += 1;
      }
      if (lane.held === true && lane.queued > 0) {
        cell.held += 1;
        cell.heldDays.add(sample.utcDay);
      }
    }
  }
  return fold;
}

const KEEP_DAYS = Math.round(RUNS_HISTORY_WINDOW_MS / 86_400_000);

const NO_CHANGE = 'If the window has rolled forward, the lane filled its target or drained its queue on a fresh read, the lane was legitimately retargeted, held or retired inside the window, the pause was a deliberate operator or guard state that has since lifted, both sampler and store verified healthy, or the right fix is owner-only (provider credentials, billing, a protected gate) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is fleet/runs-history.jsonl under the Phantom home ($ASHLR_HOME/fleet/runs-history.jsonl, ~/.ashlr/fleet/ by default; ASHLR_RUNS_HISTORY_FILE absolute overrides — runsHistoryFile() in src/core/fleet/runs-history.ts resolves it). sampleIfDue appends one RunsSample per read of GET /api/verse/runs-history — collectRunsSample folds readFleetRunsDirState (queue/status.json lanes and the pause flag) plus listLiveWorkers (this host\'s launch.sh/orch-pass.sh process counts) into {at, lanes:[{lane, running, target, queued, held}], workers, leaders, paused} — counts only, at most one sample per minute while the API is read, compaction past 2 MiB keeping seven days, reads capped at the newest 2 MiB. Its only readers until this feed were the API window itself and display projections (Command capacity panes, lane-streaks, stall windows) — surfaces someone had to open.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

function starvedPrompt(cell: RunsHistoryLaneFold, fold: RunsHistoryFold, truncated: boolean): string {
  const days = [...cell.starvedDays].sort().join(', ');
  return [
    `Phantom's fleet runs history keeps recording lane '${cell.lane}' with queued work it does not fill — backlog present while the lane ran below its own target or was scaled to zero.`,
    '',
    `Inside the store's ${KEEP_DAYS}-day window ${fold.samples} sample(s) validated; the lane appeared in ${cell.samples} of them and ${cell.starved} recorded queued > 0 while unfilled across ${cell.starvedDays.size} distinct UTC day(s) (${days}) — ${cell.underTarget} under-target (running < target) and ${cell.zeroTarget} zero-target (target === 0) records; the largest queued count recorded was ${cell.maxQueued}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Starved means the lane's own status row showed work waiting while running stayed under target — the lane never even filled its declared capacity, which is upstream of the work market's lane choice (src/core/fleet/unfed-market.ts, metrics/work-market.jsonl route_decision rows): no eligible executor for the lane's jobs, lane hints the market keeps rejecting, jobs held before dispatch, a paused fleet (see the fleet-paused cell when it emits), or a target the lane cannot physically staff. Check \`phm fleet status --json\` lanes for '${cell.lane}' current running/target/queued, \`phm fleet unfed --json\` for whether rows wait under other lanes' hints, the lane-target audit (<runs>/queue/lane-target-changes.log) and slots.json for recent retargets or holds, and whether the lane's executors exist at all. If the lane legitimately drained, was retargeted or the queue was transient ramp — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function heldPrompt(cell: RunsHistoryLaneFold, fold: RunsHistoryFold, truncated: boolean): string {
  const days = [...cell.heldDays].sort().join(', ');
  return [
    `Phantom's fleet runs history keeps recording lane '${cell.lane}' held while its queue waits — the lane's hold flag stood with queued work behind it.`,
    '',
    `Inside the store's ${KEEP_DAYS}-day window ${fold.samples} sample(s) validated; the lane appeared in ${cell.samples} of them and ${cell.held} recorded held === true with queued > 0 across ${cell.heldDays.size} distinct UTC day(s) (${days}); the largest queued count recorded was ${cell.maxQueued}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A held lane does not launch — placeLaneHold writes the flag through the guarded slots.json writers audited in <runs>/queue/lane-target-changes.log ('hold <minutes>m' placements, 'held->released' releases), and self-expiring holds close silently so a flag that outlives its stated minutes is exactly the stale state this cell names. Check \`phm fleet status --json\` for '${cell.lane}' current held state and queued depth, the lane-target audit for the hold's placement and any release, docs/LANE-HOLDS.md for which brakes set holds (autohold empty-streak, incident gate, operator brakes — note dispatchd's autobackoff holds write no audit line), and whether the hold's stated window has long passed. If the hold is deliberate and current — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function pausedPrompt(fold: RunsHistoryFold, truncated: boolean): string {
  const days = [...fold.pausedDays].sort().join(', ');
  return [
    `Phantom's fleet runs history keeps recording the fleet paused — dispatch suspended — across days while the queue recorded work waiting.`,
    '',
    `Inside the store's ${KEEP_DAYS}-day window ${fold.samples} sample(s) validated; ${fold.pausedSamples} recorded paused === true across ${fold.pausedDays.size} distinct UTC day(s) (${days}), and ${fold.pausedWithQueue} of those also recorded queued work in at least one lane.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `paused is the dispatcher's own flag from queue/status.json — set by the fleet pause control, the kill-switch family or a guard that holds admission — so a multi-day pause with queued work means either a deliberate stop nobody lifted (maintenance window, owner hold, incident brake) or a flag stuck after the pausing condition cleared. Check \`phm fleet status --json\` paused and last_tick, what wrote the pause (fleet pause verbs, KILL-family files, the memory guard's dispatch_paused path — cruise-shadow and swapout journals carry the pressure side), and whether queued jobs are still accumulating. If the pause is deliberate and current — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function corruptPrompt(fold: RunsHistoryFold, truncated: boolean): string {
  return [
    `Phantom's fleet runs-history journal keeps failing its sample contract — ${fold.corrupt} non-blank line(s) inside the retained tail are not RunsSample rows the readers accept.`,
    '',
    `Every reader — readRunsHistory behind the API, the capacity panes, lane-streaks and stall windows — skips lines parseRunsSample rejects without a trace, so foreign or torn lines accumulate invisibly while valid samples keep folding.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The contract is strict on purpose: ISO-parseable \`at\` inside 64 chars, lanes a bounded array of {lane ≤ 80 chars, running/target/queued safe integers ≥ 0, held boolean}, workers/leaders null-or-count, paused null-or-boolean. Recurring failures mean either collectRunsSample/appendRunsSample started emitting a drifted shape (a runs-history.ts change that forgot the RunsSample field set), a second process appending foreign lines to the same path, or repeated mid-line deaths leaving torn fragments. Check git log on src/core/fleet/runs-history.ts and src/core/verse/runs-history-api.ts for a recent shape drift, look for other writers of the path, and confirm the corrupt lines are not simply the tail's torn edge (a truncated read drops the partial first line, so counted failures are whole lines). If the lines verify as expected edge noise — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

type CellKind = 'lane-starved' | 'lane-held' | 'fleet-paused' | 'corrupt-lines';

interface Candidate {
  kind: CellKind;
  /** Lane name for per-lane cells, '' for fleet-wide cells. */
  cell: string;
  /** Sort weight: adverse samples for lane cells, paused samples for fleet-paused, the count for corrupt. */
  weight: number;
  item: CloudBacklogItem;
}

function itemId(kind: CellKind, cell: string, repo: string): string {
  const hash = createHash('sha256')
    .update(`runs-history:${kind}:${cell}:${repo.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `runs-history-${kind}-${hash}`;
}

function makeItem(kind: CellKind, cell: string, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, cell, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'runs-history',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const KIND_TITLE: Record<Exclude<CellKind, 'lane-starved' | 'lane-held'>, string> = {
  'fleet-paused': 'Fleet dispatch stays paused while work waits',
  'corrupt-lines': 'Runs-history journal keeps failing its sample contract',
};

/**
 * Backlog items for the fleet runs-history journal's recurring
 * starved lanes, held-with-queue lanes, paused-with-queue fleet and
 * contract-failing lines. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function runsHistoryBacklogItems(
  opts: RunsHistoryItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const journalPath = opts.journalPath ?? defaultJournalPath(opts.homeDir);
    const tail = await readLedgerTail(journalPath, RUNS_HISTORY_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const parsed = parseRunsHistoryJournal(tail.text, nowMs);
    const fold = foldRunsHistorySamples(parsed.samples, parsed.corrupt);

    const candidates: Candidate[] = [];
    for (const cell of fold.lanes.values()) {
      if (cell.starved >= RUNS_HISTORY_MIN_ADVERSE && cell.starvedDays.size >= RUNS_HISTORY_MIN_DAYS) {
        candidates.push({
          kind: 'lane-starved',
          cell: cell.lane,
          weight: cell.starved,
          item: makeItem(
            'lane-starved',
            cell.lane,
            repo,
            `Lane '${cell.lane}' keeps queued work it never fills`,
            starvedPrompt(cell, fold, tail.truncated),
          ),
        });
      }
      if (cell.held >= RUNS_HISTORY_MIN_ADVERSE && cell.heldDays.size >= RUNS_HISTORY_MIN_DAYS) {
        candidates.push({
          kind: 'lane-held',
          cell: cell.lane,
          weight: cell.held,
          item: makeItem(
            'lane-held',
            cell.lane,
            repo,
            `Lane '${cell.lane}' stays held while work waits`,
            heldPrompt(cell, fold, tail.truncated),
          ),
        });
      }
    }
    if (fold.pausedSamples >= RUNS_HISTORY_MIN_PAUSED && fold.pausedDays.size >= RUNS_HISTORY_MIN_DAYS
        && fold.pausedWithQueue >= RUNS_HISTORY_MIN_PAUSED_QUEUED) {
      candidates.push({
        kind: 'fleet-paused',
        cell: '',
        weight: fold.pausedWithQueue,
        item: makeItem('fleet-paused', '', repo, KIND_TITLE['fleet-paused'], pausedPrompt(fold, tail.truncated)),
      });
    }
    if (fold.corrupt >= RUNS_HISTORY_CORRUPT_MIN) {
      candidates.push({
        kind: 'corrupt-lines',
        cell: '',
        weight: fold.corrupt,
        item: makeItem('corrupt-lines', '', repo, KIND_TITLE['corrupt-lines'], corruptPrompt(fold, tail.truncated)),
      });
    }
    // Strongest recorded evidence first; fleet-wide pause outranks
    // per-lane cells on ties since it can explain every starved lane.
    candidates.sort((a, b) =>
      b.weight - a.weight
      || a.cell.localeCompare(b.cell)
      || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? RUNS_HISTORY_MAX_ITEMS, RUNS_HISTORY_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}

/**
 * The writer's own journal resolution, mirrored locally so this feed's
 * import closure stays inside the improve subtree: ASHLR_RUNS_HISTORY_FILE
 * when absolute, else $ASHLR_HOME/fleet/, else <home>/.ashlr/fleet/ —
 * homeDir pins the last leg for tests and never overrides the env file.
 */
function defaultJournalPath(homeDir: string | undefined): string {
  if (homeDir !== undefined) return join(homeDir, '.ashlr', 'fleet', RUNS_HISTORY_FILE_NAME);
  const override = process.env['ASHLR_RUNS_HISTORY_FILE'];
  if (typeof override === 'string' && override !== '' && isAbsolute(override)) return override;
  const ashlrHome = process.env['ASHLR_HOME'];
  const root = typeof ashlrHome === 'string' && ashlrHome.trim() !== '' && isAbsolute(ashlrHome)
    ? ashlrHome
    : join(homedir(), '.ashlr');
  return join(root, 'fleet', RUNS_HISTORY_FILE_NAME);
}
