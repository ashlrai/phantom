/**
 * Harness lifecycle ledger recurring evidence → self-improvement backlog items.
 *
 * The harness registry (src/core/learn/harness-registry.ts,
 * src/core/learn/experiments.ts) is the self-improvement loop's own
 * self-modification track: versioned config-only envelopes around the
 * fleet's models — prompt overlays, effort, sampling, routing weights and
 * enabled skills — A/B-tested against the active version on held-out
 * tasks, adopted only through the adoption gate, and watched for 48 h in
 * a canary with automatic rollback. Every lifecycle decision appends one
 * row to the authority ledger (~/.ashlr/authority/ledger.jsonl, the
 * fleet's hash-chained append-only audit log) through appendHarnessLedger:
 *
 *   harness:experiment   ExperimentResultV1 — one terminal row per
 *                        experiment (done/failed/cancelled) with its
 *                        verdict (adopt/reject/inconclusive), pair counts,
 *                        lift CI and reasons
 *   harness:adopted      HarnessTransition — a candidate entered canary
 *   harness:rolled-back  HarnessTransition — an adopted version was
 *                        restored away from (canary regression, Leader
 *                        veto, failed adoption commit)
 *   harness:rejected     HarnessTransition — a candidate version failed
 *                        its experiment's reject verdict
 *
 * Until now NO reader folded any of these kinds: the learning API and
 * Growth surface (buildLearningState) read the mutable harness state
 * file (~/.ashlr/learn/harness/state.json) for current status, the
 * authority index (src/core/authority/ledger.ts indexEntry) retains only
 * merge/revert/gate/post-merge/sandbox evidence kinds, the autonomy
 * ladder's decision view reads grant/rollout/gate/pr/merge kinds, and
 * the nightly retro sweep reads gate/pr/merge/post-merge kinds — so the
 * loop's own experiment verdicts, candidate rejections and canary
 * rollbacks were write-only audit evidence that never became work.
 * harnessBacklogItems carries the ledger into discoverBacklog:
 *
 *  - per-target adverse cells: terminal experiment outcomes that are not
 *    the gate working as designed — 'failed' (the runner died or the
 *    executor errored mid-experiment), 'cancelled' (an actor cancel or a
 *    claim refusal because the active version or held-out task-set
 *    digest moved since queueing), 'inconclusive' (the paired eval could
 *    not separate candidate from base) and 'rejected' (the verdict said
 *    no) — plus 'adoption-rolled-back' rows, each adopted version the
 *    canary or a veto took back out of production. Cells key on the
 *    hypothesis's target (prompt/effort/sampling/routing/skill) resolved
 *    through the state file's experimentMeta — the ledger row carries
 *    only the experiment id — so a routing-weight hypothesis that keeps
 *    losing reads differently from a prompt-overlay one. Meta pruned
 *    with its experiment (or a manual rollback with no experimentId)
 *    folds under 'unknown', never guessed.
 *
 * Deliberately not folded:
 *  - 'adopt' verdicts and harness:adopted rows — the success path; the
 *    adverse side of an adoption is its rollback row.
 *  - harness:rejected rows — written only when an experiment's verdict
 *    is 'reject', a strict subset of the harness:experiment rows this
 *    feed already counts (the experiment row is appended first, so it is
 *    the complete set).
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Entries come from readLedger's chain-verified read —
 *    every returned row is hash-chained evidence; a broken chain fails
 *    closed to no items (the verified prefix is not folded, matching the
 *    ledger's own caller contract). The harness state file is read
 *    once, read-only, only to resolve hypothesis targets; an unreadable
 *    or absent state degrades every cell to target 'unknown' rather than
 *    failing the feed — the ledger evidence stands on its own.
 *  - The ledger's harness rows carry repo: null — they describe this
 *    install's fleet machinery — so like the live-config, custody and
 *    self-tick feeds, items emit only when the backlog's repo name is
 *    the fleet's own; another repository inherits nothing.
 *  - Recurring means recorded. A cell emits only at HARNESS_MIN_ROWS
 *    rows across HARNESS_MIN_DAYS distinct UTC days inside the 7-day
 *    window — one failed experiment proves nothing (a crashed runner
 *    legitimately loses one).
 *  - Unknown stays unknown. Rows whose data fails the payload shape
 *    checks (missing/invalid status, verdict or ids) are skipped, never
 *    guessed; actor values are only counted (distinct recorded actors),
 *    never emitted; reason text is never read into the fold at all.
 *  - Dedup is downstream. Item ids hash the cell kind + target +
 *    repository (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the brief names the ledger, the writers
 *    and the state file, and the usual no-change escape when the window
 *    no longer reproduces or the cause is owner-only.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import type { LedgerEntry, LedgerReadOptions, LedgerReadResult } from '../authority/types.js';
import type { HarnessStateV1 } from '../learn/harness-registry.js';

/** Items one call may emit; kind × target cells are bounded but unbounded in practice. */
export const HARNESS_MAX_ITEMS = 8;
const HARNESS_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const HARNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Future-skew ceiling on ledger `at` stamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: a row stamped further
 * ahead than the evaluation time is corrupt or replayed evidence and
 * never reaches a tally.
 */
export const HARNESS_FUTURE_SKEW_MS = 60_000;
/** Adverse rows one cell needs inside the window… */
export const HARNESS_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const HARNESS_MIN_DAYS = 2;
/**
 * Newest matching ledger rows one read returns — a safety bound only;
 * experiment cadence is far below it inside a 7-day window.
 */
export const HARNESS_LEDGER_LIMIT = 2000;
/** The ledger kinds this feed folds (harness:adopted/rejected are covered by the docstring). */
export const HARNESS_LEDGER_KINDS = ['harness:experiment', 'harness:rolled-back'] as const;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: harness rows carry no repo column. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();
/** Distinct recorded actors tracked per cell; the Set only ever feeds a count. */
const ACTORS_MAX = 64;
/** Actor strings are bounded by the ledger codec already; cap what the fold retains anyway. */
const ACTOR_MAX = 120;

/** The hypothesis targets the harness config can change (HarnessTarget). */
const HARNESS_TARGETS = new Set(['prompt', 'effort', 'sampling', 'routing', 'skill']);
const UNKNOWN_TARGET = 'unknown';

/** The adverse cell kinds this feed emits, keyed by the ledger evidence behind them. */
export type HarnessCellKind =
  | 'experiment-failed'
  | 'experiment-cancelled'
  | 'experiment-inconclusive'
  | 'candidate-rejected'
  | 'adoption-rolled-back';

export interface HarnessBacklogItemsOptions {
  /** Backlog target in owner/name form; harness rows describe the fleet repo only. */
  repo: string;
  /** Authority-ledger read override (tests); default readLedger over the harness kinds. */
  readLedger?: (opts: LedgerReadOptions) => Promise<LedgerReadResult>;
  /** Harness-state reader override (tests); default the registry's loadHarnessState via lazy import. */
  loadHarnessState?: () => HarnessStateV1;
  /** Most items one call emits (default HARNESS_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated adverse ledger row inside the window. */
export interface HarnessLedgerRow {
  atMs: number;
  utcDay: string;
  kind: HarnessCellKind;
  /** The experiment id used for the hypothesis-target join (null on unattributed rollbacks). */
  experimentId: string | null;
  /** The recorded actor — counted for distinct actors, never emitted. */
  actor: string | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedId = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value.slice(0, 120) : null;

/**
 * Pure: classify one ledger entry into an adverse cell row, or null when it
 * is not foldable evidence. The ledger codec verifies the envelope and hash
 * chain but not payload internals, so every field the fold relies on is
 * shape-checked here — a row that fails is skipped, never guessed.
 * ExperimentResultV1.status 'done' carries a verdict; 'adopt' is the gate
 * working and queued/running never reach the ledger, so only the four
 * adverse terminal shapes classify.
 */
export function classifyHarnessEntry(entry: LedgerEntry): HarnessLedgerRow | null {
  const atMs = Date.parse(entry.at);
  if (!Number.isFinite(atMs)) return null;
  const actor = entry.actor.length > 0 ? entry.actor.slice(0, ACTOR_MAX) : null;
  const base = { atMs, utcDay: utcDayOf(atMs), actor };
  if (entry.kind === 'harness:experiment') {
    const data = entry.data;
    if (!isRecord(data)) return null;
    const id = boundedId(data['id']);
    if (id === null) return null;
    const status = data['status'];
    const verdict = data['verdict'];
    let kind: HarnessCellKind | null = null;
    if (status === 'failed') kind = 'experiment-failed';
    else if (status === 'cancelled') kind = 'experiment-cancelled';
    else if (status === 'done' && verdict === 'inconclusive') kind = 'experiment-inconclusive';
    else if (status === 'done' && verdict === 'reject') kind = 'candidate-rejected';
    if (kind === null) return null;
    return { ...base, kind, experimentId: id };
  }
  if (entry.kind === 'harness:rolled-back') {
    const data = entry.data;
    if (!isRecord(data)) return null;
    // versionId/fromVersionId identify the restore pair; only experimentId
    // feeds the target join, and a manual rollback legitimately carries null.
    return { ...base, kind: 'adoption-rolled-back', experimentId: boundedId(data['experimentId']) };
  }
  return null;
}

/** One (kind, target) cell's adverse track inside the window. */
export interface HarnessCellTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Distinct recorded actors — counted only, never emitted. */
  actors: Set<string>;
}

const newTrack = (): HarnessCellTrack => ({
  rows: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  actors: new Set(),
});

function trackRow(track: HarnessCellTrack, row: HarnessLedgerRow): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  if (row.actor !== null && track.actors.size < ACTORS_MAX) track.actors.add(row.actor);
}

/** One fold cell: the adverse kind, its hypothesis target and the row track. */
export interface HarnessCell {
  kind: HarnessCellKind;
  target: string;
  track: HarnessCellTrack;
}

/** The fold's output: dedupe key → cell (the key joins kind and target on a space; neither contains one). */
export type HarnessFold = Map<string, HarnessCell>;

const cellKey = (kind: HarnessCellKind, target: string): string => `${kind} ${target}`;

/**
 * Resolve an experiment id to its hypothesis target through the state
 * file's experimentMeta. Missing state, missing meta or a target outside
 * the HarnessTarget vocabulary all fold under 'unknown' — the ledger row
 * itself never guesses.
 */
export function harnessTargetOf(state: HarnessStateV1 | null, experimentId: string | null): string {
  if (state === null || experimentId === null) return UNKNOWN_TARGET;
  const meta = state.experimentMeta?.[experimentId];
  const target = meta?.hypothesis?.target;
  return typeof target === 'string' && HARNESS_TARGETS.has(target) ? target : UNKNOWN_TARGET;
}

/**
 * Pure: fold classified rows into (kind, target) cells. Rows outside the
 * window — before its start or past the evaluation time plus the sibling
 * feeds' future skew — contribute nothing.
 */
export function foldHarnessRows(
  rows: readonly HarnessLedgerRow[],
  state: HarnessStateV1 | null,
  nowMs: number,
  windowMs: number = HARNESS_WINDOW_MS,
): HarnessFold {
  const fold: HarnessFold = new Map();
  const windowStart = nowMs - windowMs;
  const until = nowMs + HARNESS_FUTURE_SKEW_MS;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > until) continue;
    const target = harnessTargetOf(state, row.experimentId);
    const key = cellKey(row.kind, target);
    let cell = fold.get(key);
    if (cell === undefined) {
      cell = { kind: row.kind, target, track: newTrack() };
      fold.set(key, cell);
    }
    trackRow(cell.track, row);
  }
  return fold;
}

const WINDOW_DAYS = Math.round(HARNESS_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the cell has gone quiet, or the cause is owner-only (a deliberate pause, credentials, billing) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is the authority ledger at ~/.ashlr/authority/ledger.jsonl — the fleet\'s hash-chained, append-only audit log — read through readLedger (src/core/authority/ledger.ts), which chain-verifies every entry before returning it. Harness lifecycle rows are appended by appendHarnessLedger (src/core/learn/harness-registry.ts): runNextExperiment and cancelExperiment (src/core/learn/experiments.ts) write harness:experiment terminal rows, adoptHarness/rollbackHarness/checkHarnessCanary write harness:adopted and harness:rolled-back, and a reject verdict also writes harness:rejected. The hypothesis target behind each experiment resolves through the harness state file ~/.ashlr/learn/harness/state.json (experimentMeta). Until now no reader folded the harness kinds: the learning API reads only current state, the authority index keeps only merge/revert/gate evidence kinds, and the nightly retro reads only gate/pr/merge kinds — the loop\'s own experiment verdicts never became work.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The ledger read was capped at its newest rows, so these counts cover only what was retained — treat every tally as a lower bound.' : '';

const meetsBar = (track: HarnessCellTrack): boolean =>
  track.rows >= HARNESS_MIN_ROWS && track.days.size >= HARNESS_MIN_DAYS;

/** A fold cell that met the recurring bar — the shape item builders consume. */
type CellCandidate = HarnessCell;

/** What each target means inside a prompt — the config area the hypothesis tried to move. */
function targetText(target: string): string {
  switch (target) {
    case 'prompt': return 'prompt overlays (per-role system-prompt additions)';
    case 'effort': return 'per-engine effort settings';
    case 'sampling': return 'per-engine sampling parameters';
    case 'routing': return 'dispatch router weights (cost/pressure/latency lambdas, best-of-N threshold)';
    case 'skill': return 'the enabled learned-skill set';
    default: return 'an unrecorded target (the experiment\'s hypothesis record is gone from the state file, or the row was a manual rollback with no experiment)';
  }
}

interface KindInfo {
  /** What the tally counts, for the prompt's first paragraph. */
  noun: string;
  /** The investigation guidance tail. */
  guidance: string;
}

const KIND_INFO: Record<HarnessCellKind, KindInfo> = {
  'experiment-failed': {
    noun: 'harness experiments that ended \'failed\' — the runner stopped mid-experiment or the executor errored',
    guidance: 'Each row is a terminal \'failed\' experiment: runNextExperiment\'s stale-lease sweep marks an experiment failed when its runner pid died or its heartbeat went stale (experiments are not resumable — the hypothesis must be re-queued), and a runner error lands the same verdict. Recurring failures mean the experiment runner keeps dying or the executor keeps erroring: check what drives runNextExperiment (the daemon\'s overnight/idle ticks through tick-hooks-live, and `local-eval --experiments`), whether the local-eval executor\'s preflight keeps refusing, whether fleet-busy slot limits starve pairs, and whether failed experiments pile up behind a dead runner lease that the sweep has not reached yet.',
  },
  'experiment-cancelled': {
    noun: 'harness experiments that ended \'cancelled\' — an actor cancel or a claim refusal after the active version or held-out task set moved',
    guidance: 'Each row is a terminal \'cancelled\' experiment: either an explicit cancel by mason/leader, or runNextExperiment\'s claim refusal — the active harness version changed since queueing, the held-out task-set digest changed, or a compared version left the registry ("re-queue the hypothesis"). Recurring cancellations mean hypotheses expire before they run: the experiment queue is not draining (runner idle, executor preflight refusing, fleet too busy for slots) or the active version churns faster than experiments complete. Check the queue depth in the harness state file, what keeps moving the active version, and whether claim-refused cancels should re-queue automatically instead of dying.',
  },
  'experiment-inconclusive': {
    noun: 'harness experiments that completed but landed \'inconclusive\' — the paired eval could not separate candidate from base',
    guidance: 'Each row is a finished experiment whose verdict was \'inconclusive\': the lift\'s 95% CI straddled zero or too few pairs completed. The held-out task set is documented as saturated (HARNESS_ADOPTION_GATE.minHeldOutTasks is 12 and the code comments note most current tasks are saturated), so recurring inconclusives mean the eval cannot measure the changes being proposed — compute is spent, no decision is produced. Check src/core/local-eval/tasks-heldout.ts coverage and difficulty spread, whether the metric has headroom for the targets being tried, and whether inconclusive experiments should feed back as a signal to propose different hypotheses rather than re-testing the same target.',
  },
  'candidate-rejected': {
    noun: 'harness experiment candidates rejected by their verdict — the adoption gate kept saying no',
    guidance: 'Each row is a finished experiment whose verdict was \'reject\': the adoption gate did not hold (pairs under 8, lift.ciLow at or below 0, a refuse-class regression, claimedChangeNoneMadeDelta above 0, or costDeltaPct above +20%). The gate working is not itself the problem — recurring rejects mean the hypothesis stream keeps proposing losers. Check where hypotheses come from (Leader memos emit up to 3 each, the daemon\'s tuning pass emits harnessHypothesesFromTuning, insights and manual entries) and whether one target dominates: per-target concentration says which proposal source or config area to fix, while rejects spread evenly say the gate may be miscalibrated for the metric\'s noise floor or the held-out set cannot see the changes being proposed.',
  },
  'adoption-rolled-back': {
    noun: 'adopted harness versions rolled back — the canary, a veto or a failed commit took a self-change back out of production',
    guidance: 'Each row is a harness:rolled-back transition: an adopted version\'s 48 h canary fell below baseline minus one standard error on live fleet runs, a Leader veto restored the prior version, or an adoption failed to commit. Every rollback is a self-change the held-out gate passed and live traffic then punished — the most expensive failure mode this machinery has. Recurring rollbacks mean the experiment→adoption pipeline ships regressions: check whether canary baselines (live outcomes vs the experiment armPasses fallback), the gate\'s lift/cost bars, or the held-out task set\'s representativeness of live traffic needs tightening, and which target the rolled-back versions touched.',
  },
};

function cellTitle(candidate: CellCandidate): string {
  const { kind, target } = candidate;
  const where = target === UNKNOWN_TARGET ? ' with an unrecorded target' : ` on ${targetText(target)}`;
  const titles: Record<HarnessCellKind, string> = {
    'experiment-failed': `Harness experiments keep failing before they finish${where}`,
    'experiment-cancelled': `Harness experiments keep being cancelled before they finish${where}`,
    'experiment-inconclusive': `Harness experiments keep finishing inconclusive${where}`,
    'candidate-rejected': `Harness candidates keep being rejected by their experiments${where}`,
    'adoption-rolled-back': `Adopted harness versions keep being rolled back${where}`,
  };
  return titles[kind];
}

function cellPrompt(candidate: CellCandidate, truncated: boolean): string {
  const { kind, target, track } = candidate;
  const info = KIND_INFO[kind];
  const span = `${track.rows} adverse row(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()})`;
  const actors = `${track.actors.size} distinct recorded actor(s)`;
  return [
    `Phantom's self-improvement harness — the config-only self-modification track that versions prompt overlays, effort, sampling, routing weights and skills, A/B-tests candidates on held-out tasks and adopts winners behind a 48 h canary — keeps recording ${info.noun} for hypothesis target '${target}'.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window the authority ledger recorded ${span}: ${actors}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The recurring target is ${targetText(target)}. ${info.guidance} If the window has rolled forward or the pattern traces to a deliberate, ended intervention — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(kind: HarnessCellKind, target: string, repo: string): string {
  const hash = createHash('sha256').update(`harness:${kind}:${target}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `harness-${kind}-${hash}`;
}

function makeItem(candidate: CellCandidate, repo: string, truncated: boolean): CloudBacklogItem {
  return {
    id: itemId(candidate.kind, candidate.target, repo),
    title: cellTitle(candidate).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(candidate, truncated),
    area: 'harness',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Deterministic order: most-recorded cells first, then kind then target. */
function sortedCells(fold: HarnessFold): CellCandidate[] {
  const kindOrder = new Map<HarnessCellKind, number>([
    ['adoption-rolled-back', 0],
    ['experiment-failed', 1],
    ['experiment-inconclusive', 2],
    ['experiment-cancelled', 3],
    ['candidate-rejected', 4],
  ]);
  return [...fold.values()]
    .sort((a, b) => b.track.rows - a.track.rows
      || (kindOrder.get(a.kind) ?? 9) - (kindOrder.get(b.kind) ?? 9)
      || a.target.localeCompare(b.target));
}

/**
 * Backlog items for the harness lifecycle ledger's recurring adverse
 * cells. Total: any read, broken-chain or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function harnessBacklogItems(opts: HarnessBacklogItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const sinceAt = new Date(nowMs - HARNESS_WINDOW_MS).toISOString();

    const read = opts.readLedger ?? (await import('../authority/ledger.js')).readLedger;
    const result = await read({ kinds: [...HARNESS_LEDGER_KINDS], sinceAt, limit: HARNESS_LEDGER_LIMIT });
    // Fail closed like every other authority-ledger consumer: a broken
    // chain means the audit trail itself is in doubt — fold nothing.
    if (result.chain === 'broken') return [];

    // The state file only enriches targets; its absence degrades to
    // 'unknown' cells rather than failing the feed.
    let state: HarnessStateV1 | null = null;
    try {
      const load = opts.loadHarnessState ?? (await import('../learn/harness-registry.js')).loadHarnessState;
      state = load();
    } catch {
      state = null;
    }

    const rows = result.entries.map(classifyHarnessEntry).filter((r): r is HarnessLedgerRow => r !== null);
    const fold = foldHarnessRows(rows, state, nowMs);

    const candidates: CellCandidate[] = [];
    for (const cell of sortedCells(fold)) {
      if (!meetsBar(cell.track)) continue;
      candidates.push(cell);
    }
    // The read's limit is a newest-rows cap; surface it honestly when hit.
    const capped = result.entries.length >= HARNESS_LEDGER_LIMIT;
    const limit = Math.max(1, Math.min(opts.limit ?? HARNESS_MAX_ITEMS, HARNESS_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((cell) => makeItem(cell, repo, capped));
  } catch {
    return [];
  }
}
