/**
 * Judge-verdict outcome ledger recurring adverse ship verdicts →
 * self-improvement backlog items.
 *
 * Every proposal the inbox merge path judges — judgeProposal in
 * src/core/fleet/manager.ts, consulted before auto-merge in
 * src/core/inbox/merge.ts — appends one metadata-only JudgeTrace to
 * ~/.ashlr/judge-traces/YYYY-MM-DD.jsonl: the proposal id, the judge
 * engine (the client model id, 'unknown' when unrecorded), the verdict
 * (ship | review | noise | harmful), the four rubric scores and the
 * timestamp — never reasoning or prompt context. Real-world outcomes
 * attach later as append-only patch rows: 'rejected' when the proposal's
 * status turns rejected (src/core/inbox/store.ts setStatus), 'reverted'
 * and 'followed-up' reserved for the post-merge observation writers, and
 * 'merged' reserved for the proof-bound release writer — today only
 * 'rejected' is linked, so the fold still honours every qualified
 * outcome the ledger contract admits. readJudgeTracesDetailed
 * materializes the newest patch onto each logical trace and reports
 * source quality; isQualifiedJudgeOutcome is the calibration readers'
 * own eligibility bar (a 'merged' label counts only with released
 * post-merge credit).
 *
 * Until now the ledger's only readers were `phm fleet judge-traces` (a
 * per-trace inspector), `phm fleet judge-health` (the kappa /
 * dark-current / degradation-harness report in
 * src/core/fleet/judge-calibration.ts) and the build-only counterfactual
 * replay in src/core/fleet/counterfactual.ts that nothing schedules —
 * reports someone had to run and read. A judge engine whose ship
 * verdicts keep resolving to work that does not hold — proposals
 * rejected before landing, or merges the observation writers later mark
 * reverted or followed-up — never became work even though the verdict
 * gates this install's own auto-merge path.
 *
 * judgeBacklogItems carries the same materialized traces into
 * discoverBacklog: per judge engine, the ship verdicts whose qualified
 * realized outcomes stayed adverse inside the window become one item
 * each once they reach the recurring bars.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The day files are read once through
 *    readJudgeTracesDetailed's bounded, safety-checked,
 *    patch-materializing read; nothing is written and no network is
 *    touched. A missing ledger is a clean empty source; a degraded or
 *    incomplete read (unsafe file, conflicting outcome patches,
 *    unreadable day, bound hit) yields no items rather than folding
 *    partial evidence — unknown stays unknown.
 *  - Rows count only under the writer's and readers' own contracts:
 *    parseTraceRow's shape validation, physical-date/file-name
 *    agreement, outcome-basis compatibility and
 *    isQualifiedJudgeOutcome's eligibility. Malformed lines, foreign
 *    schemas, future-dated rows, unqualified outcomes and patch rows
 *    whose base trace was never read are already dropped or left
 *    unapplied by the reader; the fold never guesses.
 *  - The window anchors on each trace's realized-evidence time —
 *    outcomeAt when an outcome linked, else ts — the same anchor the
 *    reader's sinceMs filter and its newest-first sort apply, so a
 *    verdict judged weeks ago whose proposal was rejected this week
 *    still counts as this week's evidence while an old resolved outcome
 *    does not.
 *  - Recurring means recorded across days: an engine cell emits only
 *    when its adverse ship outcomes reach JUDGE_SHIP_ADVERSE_MIN inside
 *    the window AND span JUDGE_MIN_DAYS distinct UTC days — one unlucky
 *    rejection never queues a session.
 *  - Only 'ship' verdicts can be judge-adverse: review, noise and
 *    harmful verdicts never approve work, so their realized outcomes
 *    record the judge's caution being validated — or, for a qualified
 *    'merged' outcome, a false negative the current writers cannot yet
 *    record — they are tallied as context only, never as the adverse
 *    cell. A qualified 'merged' outcome is the held-work count, not
 *    adverse.
 *  - Fleet machinery only: the ledger carries no repository column —
 *    every judgeProposal call site is this install's own merge path —
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling feeds apply.
 *    Dedup is downstream: the item id hashes the engine identity,
 *    never the counts or timestamps, so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; an engine
 *    that stops accruing adverse outcomes simply stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  isQualifiedJudgeOutcome,
  readJudgeTracesDetailed,
  type JudgeTrace,
  type JudgeTracesReadResult,
} from '../fleet/judge-trace.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; judge engines are few but unbounded in principle. */
export const JUDGE_BACKLOG_MAX_ITEMS = 8;
const JUDGE_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const JUDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on trace timestamps, same convention the reader tolerates. */
const JUDGE_FUTURE_SKEW_MS = 60_000;
/** Adverse ship outcomes one engine cell needs before it counts as recurring. */
export const JUDGE_SHIP_ADVERSE_MIN = 3;
/** Distinct UTC days the adverse outcomes must span — recurring means recorded across days. */
export const JUDGE_MIN_DAYS = 2;
/** The fleet's own repository label: judge evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded engine ids are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface JudgeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Evidence window in ms (default JUDGE_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default JUDGE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
  /**
   * Injected ledger read (tests); skips the real read when set. Same
   * contract as readJudgeTracesDetailed — the caller still applies the
   * healthy-only bar and the sinceMs window.
   */
  readTraces?: (filter: { sinceMs?: number }) => JudgeTracesReadResult;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded engine ids are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * The trace's realized-evidence time: outcomeAt when an outcome linked,
 * else the verdict's own ts — the same anchor the reader's sinceMs
 * filter and newest-first sort apply.
 */
function traceEventMs(trace: JudgeTrace): number | null {
  const ms = Date.parse(trace.outcomeAt ?? trace.ts);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Fold — one pass over the materialized in-window traces
// ---------------------------------------------------------------------------

/** Per-engine in-window fold before the recurring bars apply. */
export interface JudgeEngineFold {
  engine: string;
  /** Materialized in-window traces for the engine (verdicts recorded, outcome or not). */
  traces: number;
  /** Traces carrying a qualified realized outcome. */
  resolved: number;
  /** Qualified 'ship' verdicts with a realized outcome. */
  shipResolved: number;
  /** Qualified released-credit 'merged' ship outcomes — held work, never adverse. */
  shipHeld: number;
  /** 'ship' verdicts whose realized outcome was 'reverted'. */
  shipReverted: number;
  /** 'ship' verdicts whose realized outcome was 'followed-up'. */
  shipFollowedUp: number;
  /** 'ship' verdicts whose realized outcome was 'rejected'. */
  shipRejected: number;
  /** Qualified outcomes on review/noise/harmful verdicts — context only, never the adverse cell. */
  nonShipResolved: number;
  /** Distinct UTC days the adverse ship outcomes landed on. */
  adverseDays: Set<string>;
  /** ISO bounds of the adverse rows; null when the engine recorded none. */
  firstAdverseMs: number | null;
  lastAdverseMs: number | null;
}

const emptyEngineFold = (engine: string): JudgeEngineFold => ({
  engine, traces: 0, resolved: 0, shipResolved: 0, shipHeld: 0,
  shipReverted: 0, shipFollowedUp: 0, shipRejected: 0, nonShipResolved: 0,
  adverseDays: new Set(), firstAdverseMs: null, lastAdverseMs: null,
});

/**
 * Pure: fold materialized traces into per-engine verdict/outcome
 * evidence. Traces outside the window (on outcomeAt ?? ts), undated
 * traces and traces with no engine label contribute nothing; only
 * isQualifiedJudgeOutcome rows enter the outcome tallies — unqualified
 * or absent outcomes never guess.
 */
export function foldJudgeTraces(
  traces: readonly JudgeTrace[],
  nowMs: number,
  windowMs: number,
): Map<string, JudgeEngineFold> {
  const folds = new Map<string, JudgeEngineFold>();
  const since = nowMs - windowMs;
  const until = nowMs + JUDGE_FUTURE_SKEW_MS;
  for (const trace of traces) {
    const eventMs = traceEventMs(trace);
    if (eventMs === null || eventMs < since || eventMs > until) continue;
    const engine = typeof trace.judgeEngine === 'string' ? trace.judgeEngine.trim() : '';
    if (engine === '') continue;
    let cell = folds.get(engine);
    if (cell === undefined) {
      cell = emptyEngineFold(engine);
      folds.set(engine, cell);
    }
    cell.traces += 1;
    if (!isQualifiedJudgeOutcome(trace)) continue;
    cell.resolved += 1;
    const outcome = trace.outcome;
    if (trace.verdict === 'ship') {
      cell.shipResolved += 1;
      if (outcome === 'merged') {
        cell.shipHeld += 1;
        continue;
      }
      // Every other qualified outcome on a ship verdict means the
      // approval did not hold: 'rejected' never landed, 'reverted' and
      // 'followed-up' landed and then needed repair.
      if (outcome === 'reverted') cell.shipReverted += 1;
      else if (outcome === 'followed-up') cell.shipFollowedUp += 1;
      else cell.shipRejected += 1;
      cell.adverseDays.add(dayOf(eventMs));
      cell.firstAdverseMs = cell.firstAdverseMs === null ? eventMs : Math.min(cell.firstAdverseMs, eventMs);
      cell.lastAdverseMs = cell.lastAdverseMs === null ? eventMs : Math.max(cell.lastAdverseMs, eventMs);
    } else {
      cell.nonShipResolved += 1;
    }
  }
  return folds;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One emitted adverse cell: the engine plus the recorded detail the prompt quotes. */
export interface JudgeAdverseCell {
  engine: string;
  /** In-window materialized traces for the engine. */
  traces: number;
  /** Qualified outcome-linked traces across all verdicts. */
  resolved: number;
  /** Qualified 'ship' verdicts with a realized outcome. */
  shipResolved: number;
  /** Qualified released-credit 'merged' ship outcomes — held work. */
  shipHeld: number;
  shipReverted: number;
  shipFollowedUp: number;
  shipRejected: number;
  /** reverted + followed-up + rejected. */
  shipAdverse: number;
  /** Qualified outcomes on review/noise/harmful verdicts — context. */
  nonShipResolved: number;
  /** Sorted distinct UTC days the adverse outcomes landed on. */
  days: string[];
  /** ISO bounds of the adverse rows. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Pure: the recurring cells the fold justifies — engines whose adverse
 * ship outcomes reach JUDGE_SHIP_ADVERSE_MIN across JUDGE_MIN_DAYS
 * distinct UTC days. Sorted by adverse count, worst first.
 */
export function judgeAdverseCells(folds: ReadonlyMap<string, JudgeEngineFold>): JudgeAdverseCell[] {
  const cells: JudgeAdverseCell[] = [];
  for (const cell of folds.values()) {
    const shipAdverse = cell.shipReverted + cell.shipFollowedUp + cell.shipRejected;
    if (shipAdverse < JUDGE_SHIP_ADVERSE_MIN || cell.adverseDays.size < JUDGE_MIN_DAYS) continue;
    cells.push({
      engine: cell.engine,
      traces: cell.traces,
      resolved: cell.resolved,
      shipResolved: cell.shipResolved,
      shipHeld: cell.shipHeld,
      shipReverted: cell.shipReverted,
      shipFollowedUp: cell.shipFollowedUp,
      shipRejected: cell.shipRejected,
      shipAdverse,
      nonShipResolved: cell.nonShipResolved,
      days: [...cell.adverseDays].sort(),
      firstSeen: isoOrNull(cell.firstAdverseMs),
      lastSeen: isoOrNull(cell.lastAdverseMs),
    });
  }
  return cells.sort((a, b) => b.shipAdverse - a.shipAdverse || a.engine.localeCompare(b.engine));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/judge-traces/YYYY-MM-DD.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME): judgeProposal (src/core/fleet/manager.ts) records one metadata-only JudgeTrace per judged proposal — proposalId, judgeEngine (the client model id), verdict (ship|review|noise|harmful), rubric scores, ts — and outcome patches append later: \'rejected\' when setStatus turns the proposal rejected (src/core/inbox/store.ts), \'reverted\'/\'followed-up\' reserved for the post-merge observation writers, \'merged\' reserved for the proof-bound release writer. `phm fleet judge-traces [--limit N] [--proposal <id>] [--outcome-only] [--json]` inspects the ledger and `phm fleet judge-health [--degradation] [--json]` (src/core/fleet/judge-calibration.ts) reports kappa, dark-current bias and the degradation harness — reports someone had to run; the counterfactual replay (src/core/fleet/counterfactual.ts) is build-only and unscheduled.';

const NO_CHANGE = 'If the engine is no longer the frontier judge (resolveFrontierJudgeClient order in src/core/fleet/manager.ts moved on), the window has rolled forward, the recorded rejections trace to pipeline gates orthogonal to judge quality — protected paths, scope bounds, dedupe — rather than miscalibrated verdicts, or judge-health already reports the engine healthy, report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: JudgeAdverseCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

function judgePrompt(cell: JudgeAdverseCell, windowDays: number): string {
  const engine = fieldText(cell.engine) || 'unknown';
  const breakdown = [
    cell.shipReverted > 0 ? `reverted ${cell.shipReverted}` : null,
    cell.shipFollowedUp > 0 ? `followed-up ${cell.shipFollowedUp}` : null,
    cell.shipRejected > 0 ? `rejected ${cell.shipRejected}` : null,
  ].filter((part): part is string => part !== null).join(', ');
  const heldText = cell.shipHeld > 0 ? `, ${cell.shipHeld} qualified merged outcome(s) held` : '';
  const nonShipText = cell.nonShipResolved > 0
    ? ` ${cell.nonShipResolved} other resolved verdict(s) on review/noise/harmful recorded aligned outcomes.`
    : '';
  return [
    `Phantom's judge-trace ledger keeps recording adverse realized outcomes on '${engine}'s ship verdicts — ${cell.shipAdverse} of ${cell.shipResolved} qualified ship verdicts inside the ${windowDays}-day window resolved to work that did not hold (${breakdown}) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'ship' verdict is the judge's approval — the verdict the inbox merge path consults before auto-merging a proposal. ${cell.shipAdverse} of them resolved adverse: 'rejected' proposals never landed, 'reverted'/'followed-up' merges needed repair after landing.${heldText}${seenText(cell)} The engine also recorded ${cell.traces} in-window trace(s) total, ${cell.resolved} with qualified outcomes.${nonShipText}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: reproduce the tallies with \`phm fleet judge-traces --outcome-only --json\` and \`phm fleet judge-health --json\` (and \`--degradation\` for the harness) for the recorded days, then check whether the engine is still the frontier judge resolveFrontierJudgeClient selects, whether its rubric thresholds, verdict mapping or score clamps in src/core/fleet/manager.ts drifted, whether the judgeEngine label conflates models that should be separate cells, or whether the recorded rejections trace to pipeline gates orthogonal to judge quality. 'review', 'noise' and 'harmful' verdicts are not the adverse cell — their outcomes record validated caution.`,
    '',
    `Fix what lives here — the judge prompt, rubric, verdict mapping, engine resolution or trace recording in src/core/fleet/. If the engine is retired, the window has rolled forward, or the rejections are correct gate behavior the judge cannot see, ${NO_CHANGE}`,
  ].join('\n');
}

function judgeItem(cell: JudgeAdverseCell, repo: string, windowDays: number): CloudBacklogItem {
  const engine = fieldText(cell.engine) || 'unknown';
  const display = engine.length > 80 ? `${engine.slice(0, 79)}…` : engine;
  return {
    id: `judge-ship-adverse-${sha(`judge-engine:${cell.engine}`)}`,
    title: `Judge engine '${display}' keeps shipping verdicts that do not hold`.slice(0, MAX_TITLE_CHARS),
    prompt: judgePrompt(cell, windowDays),
    area: 'judge-verdicts',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the judge-trace ledger's recurring adverse ship
 * verdicts. Total: another repository, a missing ledger, a degraded or
 * incomplete read, or any read failure yields no items rather than
 * throwing into discovery.
 */
export async function judgeBacklogItems(opts: JudgeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? JUDGE_WINDOW_MS;
    const read = opts.readTraces ?? ((filter: { sinceMs?: number }) => readJudgeTracesDetailed(filter));
    const result = read({ sinceMs: nowMs - windowMs });
    // Healthy-only evidence bar: 'missing' is a clean empty ledger (no
    // traces can exist); 'degraded' or an incomplete read means outcome
    // patches, unsafe files or bounds make the fold untrustworthy —
    // both yield no items rather than guessing.
    if (result.sourceState === 'degraded' || result.complete !== true) return [];
    if (result.sourceState !== 'healthy' || result.traces.length === 0) return [];
    const folds = foldJudgeTraces(result.traces, nowMs, windowMs);
    if (folds.size === 0) return [];
    const cells = judgeAdverseCells(folds);
    const limit = Math.max(1, Math.min(opts.limit ?? JUDGE_BACKLOG_MAX_ITEMS, JUDGE_BACKLOG_ITEM_HARD_MAX));
    const windowDays = Math.round(windowMs / 86_400_000);
    return cells.slice(0, limit).map((cell) => judgeItem(cell, repo, windowDays));
  } catch {
    return [];
  }
}
