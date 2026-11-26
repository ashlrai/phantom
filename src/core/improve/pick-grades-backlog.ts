/**
 * Selector pick-grade calibration → self-improvement backlog items.
 *
 * `phm select` — run hourly by the ai.ashlr.phm.selector launchd agent
 * (src/core/routing/selector-schedule.ts) — ranks the candidate pool and
 * funds the top picks; syncPickGrades
 * (src/core/fleet/pick-grade-sync.ts) then folds <runs>/selector/
 * picks.jsonl and the metrics/jobs.jsonl tail into per-(pick, window)
 * signals and hands them to runPickGrader
 * (src/core/fleet/pick-grader.ts), which appends one
 * {pickId, window, gradedAt, predicted, realized, hit, features} row
 * per matured grade to ~/.ashlr/picks/grades.jsonl (the path
 * pickGraderPaths resolves — this feed reads the writer's own
 * location, never a second guess), nudges weights.json one SGD pass
 * toward what happened, and closes linked friction items on a 7d
 * realized >= 0.5.
 *
 * Until now the journal's only readers were the grader's own dedupe
 * set and formatPickAccuracyLine's daily-line fragment — `picks 24h
 * 7/10 70% · mae 0.21` — a report someone had to run and read. A ranker
 * whose 7d grades keep landing far from their predictions — confident
 * picks that realized almost nothing, or low-scored picks that merged
 * anyway — looked identical to a calibrated one: the SGD step keeps
 * nudging weights whether the feature signal itself is broken or the
 * realized-evidence join is too strict, and nothing ever investigated
 * which. pickGradesBacklogItems carries the recurring miscalibration
 * into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. grades.jsonl is read through readLedgerTail's bounded
 *    no-follow tail under the writer's own pickGraderPaths(home)
 *    resolution; nothing is written and no network is touched. A
 *    missing or unreadable journal contributes no grades — a fresh
 *    install simply has not graded anything yet — while a withheld
 *    read (test seam) suppresses the source entirely rather than
 *    emitting cells it cannot prove.
 *  - Rows count only under the writer's contract: a grade row needs a
 *    pickId in the grader's own id shape, window '24h' or '7d', a
 *    finite gradedAt and predicted/realized finite inside [0, 1];
 *    malformed lines, out-of-contract rows and future-dated stamps
 *    (past the sibling folds' skew allowance) are skipped, never
 *    guessed. The first recorded row per (pickId, window) wins — the
 *    writer's own dedupe key — so a duplicated line cannot double a
 *    pick's weight in a cell.
 *  - Cells read the 7d window only. The fleet's own contract already
 *    ranks the windows: the friction close trusts "only a linked
 *    pick's 7d grade ... never the 24h grade or a miss"
 *    (pick-grader.ts), and pick-grade-sync calls the 24h signals
 *    noisy by design (half the SGD rate). A 24h-only miscalibration
 *    streak is the early read doing its job, not evidence — 24h
 *    grades still count in every prompt's window denominator as
 *    context, never as cells.
 *  - A cell is signed error, not the hit flag: 'over-predicted' when
 *    predicted − realized >= PICK_GRADE_ERROR_MARGIN, 'under-predicted'
 *    when realized − predicted >= the same margin. hit (same side of
 *    0.5) is the wrong bar — a calibrated ranker misses half its
 *    coin-flip grades by construction, and boundary misses carry no
 *    information; only a wide recorded gap is evidence the prediction
 *    itself was wrong. realized takes its recorded blend's discrete
 *    values (0, used-only, merged) and predicted is the ranker's
 *    clamped output, so the margin names a plain-language gap on the
 *    [0, 1] scale.
 *  - Recurring means recorded across days: a class emits only at
 *    PICK_GRADE_MIN_GRADES distinct pick ids across
 *    PICK_GRADE_MIN_DAYS distinct UTC days of gradedAt inside the
 *    7-day window — the fleet's RECURRING_FAILURES convention the
 *    sibling feeds apply.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository (the same last-segment rule the sibling
 *    fleet-evidence sources apply) — the selector, its schedule, the
 *    grader and the journals are this install's machinery, and the
 *    grades describe picks this fleet funded. Dedup is downstream:
 *    the item id hashes the class plus the repository — never the
 *    counts or timestamps — so a refresh re-derives the same id and
 *    a class that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example pick ids must match the
 *    ledger's own RQ-* id shape before they are quoted, predicted
 *    bands admit only the fixed vocabulary below, truncated tails are
 *    stated as lower bounds, and the brief names the journals, the
 *    writer and the handoff stages with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { pickGraderPaths, type GradeWindow } from '../fleet/pick-grader.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the adverse-class set is small and closed. */
export const PICK_GRADES_BACKLOG_MAX_ITEMS = 4;
const PICK_GRADES_BACKLOG_ITEM_HARD_MAX = 10;
/** Evidence window: the sibling fleet-evidence convention. */
export const PICK_GRADES_WINDOW_HOURS = 168;
/** A class emits only at this many distinct graded picks inside the window... */
export const PICK_GRADE_MIN_GRADES = 3;
/** ...spread across at least this many distinct UTC days. */
export const PICK_GRADE_MIN_DAYS = 2;
/**
 * The signed-error bar on the [0, 1] scale: predicted − realized at
 * least this far apart in either direction is miscalibration worth
 * work; below it the grade is ordinary ranker variance the daily
 * line's MAE already summarizes.
 */
export const PICK_GRADE_ERROR_MARGIN = 0.4;
/** The grades journal is append-only and unbounded; a 1 MiB tail holds years of hourly grades. */
const PICK_GRADES_TAIL_BYTES = 1024 * 1024;
/** The fleet's own repository label: grade evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/**
 * The id shape the grader accepts (pick-grade-sync.ts PICK_ID): any
 * journal-safe token. Rows outside it are malformed and skipped.
 */
const GRADER_PICK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The stricter queue-job id shape pick ids carry in practice; only these are quoted inside prompts. */
const SAFE_PICK_ID = /^RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Example pick ids quoted inside one prompt. */
const MAX_PROMPT_EXAMPLES = 3;
/** Prediction-band tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface PickGradesItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home for the grader's ~/.ashlr/picks resolution (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default PICK_GRADES_WINDOW_HOURS). */
  windowHours?: number;
  /**
   * Test injection for the grades journal: undefined reads
   * ~/.ashlr/picks/grades.jsonl live through the bounded tail, a string
   * stands in for a healthy read (treated as untruncated), and null
   * stands in for a withheld journal — which suppresses the source.
   */
  gradesText?: string | null;
  /** Most items one call emits (default PICK_GRADES_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — the journal's own recorded grades, classified by signed error
// ---------------------------------------------------------------------------

/** The adverse classes a 7d grade can land in; anything closer is context. */
export type PickGradeClass = 'over-predicted' | 'under-predicted';

/** One journal row that passed the writer's contract. */
export interface PickGradeRow {
  pickId: string;
  window: GradeWindow;
  /** gradedAt in epoch ms. */
  gradedAtMs: number;
  predicted: number;
  realized: number;
}

/**
 * Pure: parse grades.jsonl text into contract-valid rows. The first
 * recorded row per (pickId, window) wins — the writer's own dedupe
 * key — so a duplicated or torn-rewrite line cannot double a pick.
 */
export function pickGradeRows(text: string): PickGradeRow[] {
  const seen = new Set<string>();
  const rows: PickGradeRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const pickId = row['pickId'];
    const window = row['window'];
    const gradedAt = row['gradedAt'];
    const predicted = row['predicted'];
    const realized = row['realized'];
    if (typeof pickId !== 'string' || !GRADER_PICK_ID.test(pickId)) continue;
    if (window !== '24h' && window !== '7d') continue;
    if (typeof gradedAt !== 'number' || !Number.isFinite(gradedAt)) continue;
    if (typeof predicted !== 'number' || !Number.isFinite(predicted) || predicted < 0 || predicted > 1) continue;
    if (typeof realized !== 'number' || !Number.isFinite(realized) || realized < 0 || realized > 1) continue;
    const key = `${pickId}:${window}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ pickId, window, gradedAtMs: gradedAt, predicted, realized });
  }
  return rows;
}

/**
 * Pure: the class one 7d grade lands in from its recorded signed error,
 * or null inside the margin. Only ever called for window '7d' rows —
 * the fold applies the window rule before this.
 */
export function classifyPickGrade(row: PickGradeRow): PickGradeClass | null {
  const err = row.predicted - row.realized;
  if (err >= PICK_GRADE_ERROR_MARGIN) return 'over-predicted';
  if (err <= -PICK_GRADE_ERROR_MARGIN) return 'under-predicted';
  return null;
}

/** The writer's hit rule, re-derived so prompts quote it rather than trusting the flag. */
const isHit = (row: PickGradeRow): boolean => (row.predicted >= 0.5) === (row.realized >= 0.5);

export interface PickGradeTally {
  /** Sanitized recorded text (a fixed prediction-band label). */
  text: string;
  count: number;
}

/** One emitted recurring miscalibration class: the grade fold plus journal tallies. */
export interface PickGradeCell {
  cls: PickGradeClass;
  /** Distinct pick ids in the class inside the window. */
  grades: number;
  /** Sorted distinct UTC days the grades' gradedAt landed on. */
  days: string[];
  /** Up to MAX_PROMPT_EXAMPLES pick ids, sorted — each already matched SAFE_PICK_ID. */
  examples: string[];
  /** Predicted-value band tallies, most frequent first. */
  predictions: PickGradeTally[];
  /** Mean |predicted − realized| across the class's grades, rounded to 2 decimals. */
  meanError: number;
  /** ISO bounds of the class's grades; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail was truncated: tallies are a lower bound. */
  gradesLowerBound: boolean;
}

/** Window-wide counts quoted inside every prompt — the honest denominator. */
export interface PickGradesWindow {
  /** Dated in-window 7d grades — the only rows cells read. */
  graded7d: number;
  /** Dated in-window 24h grades — context only, never cells. */
  graded24h: number;
  /** Of graded7d, rows whose predicted/realized landed on the same side of 0.5. */
  hits7d: number;
  /** Per-class 7d grade counts inside the window before the recurring bars (absent when zero). */
  adverse: Map<PickGradeClass, number>;
}

/** Fixed prediction bands — the only vocabulary a prompt may quote. */
function predictionBand(predicted: number): string {
  if (predicted < 0.5) return 'under-0.5';
  if (predicted < 0.7) return '0.5-0.7';
  if (predicted < 0.9) return '0.7-0.9';
  return '0.9-plus';
}

function tallyOf(map: Map<string, number>, max: number): PickGradeTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: classify every dated in-window 7d grade and keep the adverse
 * classes that meet the recurring bars. Sorted by grade count, busiest
 * class first; the window counts ride along so prompts quote the whole
 * denominator. 24h rows and out-of-window rows are context only.
 */
export function pickGradeCells(
  rows: readonly PickGradeRow[],
  nowMs: number,
  windowHours: number,
  opts: { gradesLowerBound?: boolean } = {},
): { cells: PickGradeCell[]; window: PickGradesWindow } {
  interface Acc {
    ids: Set<string>;
    days: Set<string>;
    firstMs: number;
    lastMs: number;
    examples: string[];
    predictions: Map<string, number>;
    errorSum: number;
  }
  const newAcc = (): Acc => ({
    ids: new Set(), days: new Set(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY,
    examples: [], predictions: new Map(), errorSum: 0,
  });
  const adverse = new Map<PickGradeClass, Acc>();
  const windowCounts: PickGradesWindow = { graded7d: 0, graded24h: 0, hits7d: 0, adverse: new Map() };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;

  for (const row of rows) {
    if (row.gradedAtMs < since || row.gradedAtMs > until) continue;
    if (row.window === '24h') {
      windowCounts.graded24h += 1;
      continue;
    }
    windowCounts.graded7d += 1;
    if (isHit(row)) windowCounts.hits7d += 1;
    const cls = classifyPickGrade(row);
    if (cls === null) continue;
    windowCounts.adverse.set(cls, (windowCounts.adverse.get(cls) ?? 0) + 1);
    let acc = adverse.get(cls);
    if (acc === undefined) {
      acc = newAcc();
      adverse.set(cls, acc);
    }
    acc.ids.add(row.pickId);
    acc.days.add(dayOf(row.gradedAtMs));
    acc.firstMs = Math.min(acc.firstMs, row.gradedAtMs);
    acc.lastMs = Math.max(acc.lastMs, row.gradedAtMs);
    if (acc.examples.length < MAX_PROMPT_EXAMPLES && !acc.examples.includes(row.pickId) && SAFE_PICK_ID.test(row.pickId)) {
      acc.examples.push(row.pickId);
    }
    const band = predictionBand(row.predicted);
    acc.predictions.set(band, (acc.predictions.get(band) ?? 0) + 1);
    acc.errorSum += Math.abs(row.predicted - row.realized);
  }

  const cells: PickGradeCell[] = [];
  for (const [cls, acc] of adverse) {
    if (acc.ids.size < PICK_GRADE_MIN_GRADES || acc.days.size < PICK_GRADE_MIN_DAYS) continue;
    cells.push({
      cls,
      grades: acc.ids.size,
      days: [...acc.days].sort(),
      examples: [...acc.examples].sort(),
      predictions: tallyOf(acc.predictions, MAX_PROMPT_TALLIES),
      meanError: Math.round((acc.errorSum / acc.ids.size) * 100) / 100,
      firstSeen: isoOrNull(Number.isFinite(acc.firstMs) ? acc.firstMs : null),
      lastSeen: isoOrNull(Number.isFinite(acc.lastMs) ? acc.lastMs : null),
      gradesLowerBound: opts.gradesLowerBound === true,
    });
  }
  cells.sort((a, b) => b.grades - a.grades || a.cls.localeCompare(b.cls));
  return { cells, window: windowCounts };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const WINDOW_DAYS = Math.round(PICK_GRADES_WINDOW_HOURS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the grades\' picks have since hit their predictions, the misses were correct verdicts on genuinely uncertain picks rather than a broken signal, the miscalibration was already fixed and the journal simply has not aged out, or the cause is owner-only or pinned ops machinery (credentials, billing, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is ~/.ashlr/picks/grades.jsonl under the home directory pickGraderPaths resolves (src/core/fleet/pick-grader.ts): syncPickGrades — run on every non-dry `phm select` pass by the hourly ai.ashlr.phm.selector schedule — folds <runs>/selector/picks.jsonl funded picks against the metrics/jobs.jsonl tail into per-(pick, window) merged/used signals and runPickGrader appends one {pickId, window, 24h|7d, gradedAt, predicted, realized, hit, features} row per matured grade while nudging ~/.ashlr/picks/weights.json one SGD pass. Until now the journal\'s only readers were the grader\'s own dedupe set and the daily line\'s accuracy fragment; this feed is the same recorded grades reaching the backlog.';

const truncationNote = (cell: PickGradeCell): string =>
  cell.gradesLowerBound
    ? ' The grades journal\'s tail was truncated at the bounded read, so the tallies cover only the retained window — a lower bound.'
    : '';

const tallyText = (tallies: readonly PickGradeTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

/** The window denominator: every in-window grade's recorded verdict, so the cell never reads as the whole story. */
function windowText(window: PickGradesWindow): string {
  const adverse = [...window.adverse.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`);
  const parts = [
    `${window.hits7d} of ${window.graded7d} 7d grade(s) hit`,
    ...(adverse.length > 0 ? [adverse.join(', ')] : []),
    `${window.graded24h} 24h grade(s) held as context`,
  ];
  return ` Inside the same window the grader recorded ${window.graded7d} dated 7d grade(s) and ${window.graded24h} dated 24h grade(s); the recorded verdicts were ${parts.join(', ')} — the 24h read is the noisy early signal the fleet's own contract never grades trust on.`;
}

const detailText = (cell: PickGradeCell): string => {
  const parts: string[] = [];
  if (cell.examples.length > 0) parts.push(`Example pick id(s): ${cell.examples.join(', ')}.`);
  if (cell.predictions.length > 0) parts.push(`Recorded predicted band(s): ${tallyText(cell.predictions)}.`);
  parts.push(`Mean |predicted − realized| across the class: ${cell.meanError.toFixed(2)}.`);
  return ` ${parts.join(' ')}`;
};

interface ClassMeta {
  title: string;
  /** The opening claim sentence — what keeps happening. */
  lead: string;
  /** The diagnostic paragraph: where to look and what this repo owns. */
  diagnose: string;
}

const CLASS_META: Record<PickGradeClass, ClassMeta> = {
  'over-predicted': {
    title: 'Selector pick grades keep over-predicting realized outcomes',
    lead: 'Phantom\'s selector keeps funding picks whose recorded 7d grades land far below their predictions — the ranker is confident and reality keeps disagreeing.',
    diagnose: `Each row is a 7d grade whose predicted − realized gap reached ${PICK_GRADE_ERROR_MARGIN} on the [0, 1] scale: picks the ranker scored high that produced little or no held outcome inside their window. Trace the example pick ids stage by stage — the selector/picks.jsonl row (recorded mergeRate, score, predictedValue, basis), the grades.jsonl row (predicted vs realized), the metrics/jobs.jsonl outcome rows pick-grade-sync's fold reads (heldMergeInWindow's revert discount, isUsedEvidence's publish-claim/PR-url rule), and ~/.ashlr/picks/weights.json's drift — then decide which side is broken: the mergeRate prior or feature set itself (a stale or inverted signal in selector ranking), the realized-evidence join (a held merge discounted by hasRevertEvidence, a publish claim too strict to count 'used', a coverage guard deferring grades it should score), or the SGD step (RATE per window, clamp01 saturation flattening weights). Check whether the same feature bands keep producing the misses — the tallies name where the confidence sat. Fix what lives in this repository — the ranking signal, the evidence join, the weight update or the realized blend; if the predictions were honestly uncertain and the misses are ordinary variance a wider margin would not call adverse — report no-change and name the evidence.`,
  },
  'under-predicted': {
    title: 'Selector pick grades keep under-predicting realized outcomes',
    lead: 'Phantom\'s selector keeps scoring picks low that then realize far above their predictions — good work the ranker does not see coming.',
    diagnose: `Each row is a 7d grade whose realized − predicted gap reached ${PICK_GRADE_ERROR_MARGIN} on the [0, 1] scale: picks the ranker scored low that still merged or produced reviewable work inside their window — the fleet is leaving signal on the table. Trace the example pick ids stage by stage — the selector/picks.jsonl row (recorded mergeRate, score, predictedValue, basis), the grades.jsonl row (predicted vs realized), the metrics/jobs.jsonl outcome rows pick-grade-sync's fold reads, and ~/.ashlr/picks/weights.json's drift — then decide which side is broken: the mergeRate prior under-rating a class of picks (the recorded prior may predate a machinery fix that raised real merge rates), a feature the ranker cannot see (repo, lane or jobType signal present in picks.jsonl but absent from the {mergeRate}-only feature set pick-grade-sync feeds the grader), or the realized blend over-crediting marginal outcomes. Check whether the under-predicted picks cluster on one repo, lane or jobType — cross-reference the picks.jsonl rows the ids name. Fix what lives in this repository — the prior, the feature set, the evidence join or the weight update; if the high realizations were one-off luck a wider margin would not call systematic — report no-change and name the evidence.`,
  },
};

function pickGradePrompt(cell: PickGradeCell, window: PickGradesWindow, repo: string): string {
  const meta = CLASS_META[cell.cls];
  const first = cell.firstSeen === null ? null : Date.parse(cell.firstSeen);
  const last = cell.lastSeen === null ? null : Date.parse(cell.lastSeen);
  const span = first !== null && last !== null ? ` (${daySpan(first, last)}-day span, first ${cell.firstSeen}, last ${cell.lastSeen})` : '';
  const direction = cell.cls === 'over-predicted' ? 'predicted above realized' : 'realized above predicted';
  return [
    `${meta.lead} ${cell.grades} graded pick(s) landed in this class inside the ${WINDOW_DAYS}-day window on ${repo}, the self-improvement work this backlog exists for.`,
    '',
    `The grades journal recorded ${cell.grades} distinct pick id(s) in this class across ${cell.days.length} UTC day(s) (${daysText(cell.days)})${span}, each a 7d grade ${direction} by at least ${PICK_GRADE_ERROR_MARGIN}.${detailText(cell)}${windowText(window)}${truncationNote(cell)}`,
    '',
    EVIDENCE,
    '',
    meta.diagnose,
    '',
    `Run the affected suite (test/pick-grader.test.ts, test/pick-grade-sync.test.ts, test/improve-pick-grades-backlog.test.ts). ${NO_CHANGE}`,
  ].join('\n');
}

function pickGradeItem(cell: PickGradeCell, window: PickGradesWindow, repo: string): CloudBacklogItem {
  return {
    id: `pick-grades-${cell.cls}-${sha(`pick-grades:${cell.cls}:${repo.toLowerCase()}`)}`,
    title: `${CLASS_META[cell.cls].title} on ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: pickGradePrompt(cell, window, repo),
    area: 'pick-grades',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the selector ranker's recurring 7d miscalibration
 * classes. Total: any read or fold failure yields no items rather than
 * throwing into discovery — a withheld journal yields none too, since
 * the feed IS the recorded grades.
 */
export async function pickGradesBacklogItems(
  opts: PickGradesItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? PICK_GRADES_WINDOW_HOURS;

    // The grades journal IS the evidence: a withheld read leaves every
    // grade unknown, so the source stays quiet rather than emitting
    // cells it cannot prove; a genuinely absent journal is the same
    // unknown, never an empty success.
    let gradesText: string;
    let gradesLowerBound = false;
    if (opts.gradesText !== undefined) {
      if (opts.gradesText === null) return [];
      gradesText = opts.gradesText;
    } else {
      const tail = await readLedgerTail(pickGraderPaths(home).grades, PICK_GRADES_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      gradesText = tail.text;
      gradesLowerBound = tail.truncated;
    }

    const rows = pickGradeRows(gradesText);
    if (rows.length === 0) return [];

    const { cells, window } = pickGradeCells(rows, nowMs, windowHours, { gradesLowerBound });
    const limit = Math.max(1, Math.min(opts.limit ?? PICK_GRADES_BACKLOG_MAX_ITEMS, PICK_GRADES_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => pickGradeItem(cell, window, repo));
  } catch {
    return [];
  }
}
