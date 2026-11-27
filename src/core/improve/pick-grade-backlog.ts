/**
 * Selector pick-grade journal starvation → self-improvement backlog items.
 *
 * Every non-dry `phm select` pass ends by grading the funded picks it
 * journals to <runs>/selector/picks.jsonl against <runs>/metrics/jobs.jsonl
 * (src/cli/select.ts → src/core/fleet/pick-grade-sync.ts syncPickGrades →
 * src/core/fleet/pick-grader.ts runPickGrader): each pick is graded 24h and
 * 7d after its `at`, grades append to ~/.ashlr/picks/grades.jsonl, the SGD
 * step rewrites ~/.ashlr/picks/weights.json beside it, and a 7d grade with
 * realized >= 0.5 closes the pick's friction_id ledger item — the only
 * automatic close the friction contract promises (CONTRACT-SELECTOR.md).
 * selectorPicksBacklogItems folds what the funded picks' JOBS did; nothing
 * folded whether the grading pass itself is landing grades.
 *
 * Two starvation cells in that chain never became work:
 *
 *  - Coverage-stranded picks: the grader's coverage guard defers any pick
 *    whose window start precedes the retained jobs tail's first dated row
 *    (foldPickGradeEvidence's coverageStartMs — "a pick funded before the
 *    retained tail can never be proven — it stays ungraded, which is the
 *    honest answer", pick-grade-sync.ts). Honest per pick, but the tail is
 *    finite: once the fleet's jobs-ledger growth pushes a pick's funding
 *    time out of the 16 MiB window its 24h and 7d grades can never land,
 *    weights.json stops moving for it and the grader-7d friction close is
 *    dead letter — silently, because syncPickGrades reports the deferral
 *    as routine.
 *  - Gradeable-but-ungraded picks: the same guard passes — the retained
 *    tail still reaches the pick's funding time — yet no grade row exists
 *    past the window plus a day's grace. The hourly pass is not reaching
 *    runPickGrader: the launchd agent is not installed or loaded, select
 *    is erroring before the grading stage, or the grades append is
 *    failing — and syncPickGrades swallows every one of those into a
 *    state string on a stderr line nothing folds.
 *
 * pickGradeBacklogItems carries both cells into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue them like
 * the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Three bounded no-follow tails are read once each through
 *    readLedgerTail; nothing is written and no network is touched. A
 *    missing or unreadable picks journal yields no items (nothing was
 *    funded or nothing can be read). A missing grades journal is
 *    proven-empty — the writer's own readGrades returns [] the same way —
 *    while an unreadable, non-file or undated-content one cannot prove
 *    absence and stays quiet. A missing or unreadable jobs ledger leaves
 *    coverage unknowable, so both cells stay silent — matching the sync,
 *    whose fold is null in exactly that case.
 *  - The pick set is the grader's own: selectorPickRecords is the exact
 *    parse syncPickGrades feeds runPickGrader, so rows it rejects are
 *    rows the grader never saw — never counted here either. Picks are
 *    deduped by id, first row wins, like every sibling fold.
 *  - A missing grade is proven, not guessed: a (pick, window) grade can
 *    only have been written at or after pickedAt + window, so when that
 *    earliest possible write already sits inside the retained grades
 *    tail's coverage, an absent row means no grade was ever recorded —
 *    a grade that could have aged out of the tail keeps the pick out of
 *    both cells. Grades-journal truncation therefore narrows what can be
 *    proven rather than fabricating absences.
 *  - Recurring means recorded: a cell emits only at
 *    PICK_GRADE_MIN_PICKS distinct picks across PICK_GRADE_MIN_DAYS
 *    distinct UTC days, so one deferred pick or one missed pass never
 *    queues a session. Both cells are present-tense — a pick still
 *    ungraded is still ungraded — so every proven pick in the retained
 *    tail counts, windowed or not, and truncation is stated as a lower
 *    bound.
 *  - Fleet machinery only: the journals are this install's selector and
 *    grader record, so items emit only for the fleet's own repository —
 *    the same last-segment 'phantom' rule the sibling fleet-evidence
 *    feeds apply.
 *  - Dedup is downstream: item ids hash the bucket + repository identity
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; a fleet whose
 *    grades land again simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, pick ids are scrubbed, flattened and capped, and
 *    the brief names all three journals, the grading contract and the
 *    usual no-change escape when the window no longer reproduces or the
 *    cause is owner-side.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { GRADE_WINDOWS, type GradeWindow } from '../fleet/pick-grader.js';
import { foldPickGradeEvidence, selectorPickRecords } from '../fleet/pick-grade-sync.js';
import {
  readLedgerTail,
  ROUTER_OUTCOME_LEDGER_LIMIT,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
} from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the bucket set is closed at two. */
export const PICK_GRADE_BACKLOG_MAX_ITEMS = 4;
const PICK_GRADE_ITEM_HARD_MAX = 25;
/**
 * A window counts as overdue only this long after it closes — the hourly
 * pass plus launchd and manual-run slack can lag a few hours, so a full
 * day of silence is a missed cadence, not jitter.
 */
export const PICK_GRADE_DUE_GRACE_MS = 24 * 60 * 60 * 1000;
/** Distinct ungraded picks a bucket needs before it emits. */
export const PICK_GRADE_MIN_PICKS = 3;
/** Distinct UTC days that evidence must span — recurring means recorded across days. */
export const PICK_GRADE_MIN_DAYS = 2;
/** Future-skew allowance on journal timestamps, same convention the sibling folds apply. */
const PICK_GRADE_FUTURE_SKEW_MS = 300_000;
/**
 * Bounded tail per journal — the same 16 MiB readLedgerTail bound
 * syncPickGrades applies to the picks and jobs journals, so this fold
 * sees exactly the pick set and coverage horizon the grader does. The
 * grades journal is append-only and small; the same bound keeps its
 * read honest via the coverage-start rule rather than unbounded.
 */
const PICK_GRADE_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** Pick ids quoted inside one prompt before the remainder is summarized. */
const PROMPT_PICKS_MAX = 5;
/** Journal-recorded pick ids are unbounded text; cap before prompt use. */
const PICK_ID_MAX = 200;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: grading evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

const GRADE_WINDOW_IDS = Object.keys(GRADE_WINDOWS) as GradeWindow[];

type Bucket = 'stranded' | 'missing';

export interface PickGradeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding selector/picks.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set and non-empty. */
  runsDir?: string;
  /** Home for the default runs dir and the grades journal (default: os.homedir()). */
  homeDir?: string;
  /** Picks journal override (default: <runsDir>/selector/picks.jsonl). */
  picksPath?: string;
  /** Jobs ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  jobsPath?: string;
  /** Grades journal override (default: <home>/.ashlr/picks/grades.jsonl — the writer's homedir resolution, ASHLR_HOME-independent). */
  gradesPath?: string;
  /** Injected picks-journal text (tests); skips the journal read when set — null means missing. */
  picksText?: string | null;
  /** Injected jobs-ledger text (tests); skips the ledger read when set — null means withheld. */
  jobsText?: string | null;
  /** Injected grades-journal text (tests); skips the journal read when set — null means missing. */
  gradesText?: string | null;
  /** Most items one call emits (default PICK_GRADE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the due bars and window coverage (default: now). */
  now?: Date;
}

/** The repository name the fleet-machinery rule matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Journal-recorded pick ids are unbounded text; scrub, flatten and cap before prompt use. */
function fieldText(value: string, max = PICK_ID_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------------------
// Fold — the three journals' pure joins
// ---------------------------------------------------------------------------

/**
 * The retained grades journal, folded to what the cells need: the set of
 * (window, pickId) grades on record and the oldest retained grade
 * timestamp. `coverageStartMs` follows the same convention
 * foldPickGradeEvidence applies to the jobs tail — the first dated row in
 * tail order — so a grade whose earliest possible write precedes it could
 * have aged out of the bounded read and proves nothing either way.
 */
export interface GradesJournalFold {
  /** `${window}:${pickId}` keys for every valid grade row retained. */
  graded: ReadonlySet<string>;
  /** Oldest retained gradedAt; null when no dated row survives — every grade would be visible. */
  coverageStartMs: number | null;
  /** Newest retained gradedAt; null when no dated row survives. */
  newestMs: number | null;
  /** Valid grade rows parsed. */
  rows: number;
  /** Non-blank lines that were not usable grade rows. */
  malformed: number;
}

const gradeKey = (window: GradeWindow, pickId: string): string => `${window}:${pickId}`;

/**
 * Pure: parse grades.jsonl text into the retained grade set. Only rows
 * under the writer's PickGrade contract count — a string pickId, a
 * '24h'/'7d' window and (for coverage purposes) a finite gradedAt;
 * malformed lines are skipped, never guessed. Rows missing a usable
 * gradedAt still mark their (window, pick) graded — the writer's own
 * readGrades counts them — they just cannot move the coverage bound.
 */
export function foldPickGradesJournal(text: string): GradesJournalFold {
  const graded = new Set<string>();
  let coverageStartMs: number | null = null;
  let newestMs: number | null = null;
  let rows = 0;
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(value)) {
      malformed += 1;
      continue;
    }
    const pickId = value['pickId'];
    const window = value['window'];
    if (typeof pickId !== 'string' || pickId === '' || pickId.length > PICK_ID_MAX) {
      malformed += 1;
      continue;
    }
    if (typeof window !== 'string' || !(window in GRADE_WINDOWS)) {
      malformed += 1;
      continue;
    }
    graded.add(gradeKey(window as GradeWindow, pickId));
    rows += 1;
    const gradedAt = value['gradedAt'];
    if (typeof gradedAt === 'number' && Number.isFinite(gradedAt)) {
      // Tail order is append order: the first dated row is the oldest
      // retained grade — the same coverage convention foldPickGradeEvidence
      // applies to the jobs tail. newestMs tracks the maximum seen.
      if (coverageStartMs === null) coverageStartMs = gradedAt;
      if (newestMs === null || gradedAt > newestMs) newestMs = gradedAt;
    }
  }
  return { graded, coverageStartMs, newestMs, rows, malformed };
}

/** One funded pick carrying proven-ungraded windows into a cell. */
export interface UngradedPickCell {
  /** The READY-line/job id the pick funded (RQ-*). */
  id: string;
  pickedAtMs: number;
  utcDay: string;
  /** True when the pick carries a frictionId — a friction-ledger-sourced candidate. */
  friction: boolean;
  /** The proven-ungraded windows whose due+grace has passed ('24h' and/or '7d'). */
  windows: GradeWindow[];
}

export interface PickGradeBacklogFold {
  /** Distinct funded picks examined (deduped by id, the writer funds each id once). */
  picks: number;
  /** picks.jsonl rows selectorPickRecords rejected — the grader never saw them either. */
  skipped: number;
  /** Picks with at least one proven-ungraded window the jobs tail can no longer reach. */
  stranded: UngradedPickCell[];
  /** Picks with at least one proven-ungraded window inside jobs-tail coverage. */
  missing: UngradedPickCell[];
  /** The jobs tail's first dated row — the coverage horizon syncPickGrades' guard sees. */
  jobsCoverageStartMs: number | null;
  /** Retained grades-journal rows (0 when the journal is missing). */
  gradesRows: number;
  /** Oldest retained gradedAt; null when the journal is missing or holds no dated row. */
  gradesCoverageStartMs: number | null;
  /** Newest retained gradedAt; null when the journal is missing or holds no dated row. */
  newestGradeMs: number | null;
  /** 'missing' when no grades journal exists — zero grades on record, proven. */
  gradesJournal: 'read' | 'missing';
}

const EMPTY_GRADES: GradesJournalFold = { graded: new Set(), coverageStartMs: null, newestMs: null, rows: 0, malformed: 0 };

/**
 * Pure: join the picks tail, the grades tail and the jobs coverage
 * horizon into the two starvation cells. A (pick, window) counts as
 * proven-ungraded only when all three hold: the window closed more than
 * PICK_GRADE_DUE_GRACE_MS ago, no grade row for it survives in the
 * retained grades tail, and the window's earliest possible write
 * (pickedAt + window) sits inside the grades tail's coverage — so an
 * absent row is a proven absence, never a grade that aged out. The
 * stranded/missing split is the writer's own rule: pickedAt before the
 * jobs tail's first dated row defers forever; at or after it the guard
 * passes and a missing grade means the pass never reached the grader.
 */
export function foldPickGradeBacklog(
  picksText: string,
  gradesText: string | null,
  jobsCoverageStartMs: number | null,
  nowMs: number,
): PickGradeBacklogFold {
  const { picks, skipped } = selectorPickRecords(picksText);
  const grades = gradesText === null ? EMPTY_GRADES : foldPickGradesJournal(gradesText);
  // A missing journal is proven-empty — the writer's readGrades returns []
  // identically. A read journal with content but no dated row gives no
  // coverage bound at all: dated grades could have aged out of the tail
  // unseen, so absence is unproven and no window may count. Only a
  // genuinely blank journal proves empty.
  const gradesUnprovable = gradesText !== null
    && grades.coverageStartMs === null
    && grades.rows + grades.malformed > 0;
  const seen = new Set<string>();
  const stranded: UngradedPickCell[] = [];
  const missing: UngradedPickCell[] = [];
  for (const pick of picks) {
    if (seen.has(pick.id)) continue;
    seen.add(pick.id);
    if (pick.pickedAt > nowMs + PICK_GRADE_FUTURE_SKEW_MS) continue;
    if (jobsCoverageStartMs === null) continue;
    const windows: GradeWindow[] = [];
    if (!gradesUnprovable) {
      for (const window of GRADE_WINDOW_IDS) {
        const windowStartMs = pick.pickedAt + GRADE_WINDOWS[window];
        if (nowMs < windowStartMs + PICK_GRADE_DUE_GRACE_MS) continue;
        if (grades.graded.has(gradeKey(window, pick.id))) continue;
        if (grades.coverageStartMs !== null && windowStartMs < grades.coverageStartMs) continue;
        windows.push(window);
      }
    }
    if (windows.length === 0) continue;
    const cell: UngradedPickCell = {
      id: pick.id,
      pickedAtMs: pick.pickedAt,
      utcDay: dayOf(pick.pickedAt),
      friction: typeof pick.frictionId === 'string' && pick.frictionId.trim() !== '',
      windows,
    };
    if (pick.pickedAt < jobsCoverageStartMs) stranded.push(cell);
    else missing.push(cell);
  }
  return {
    picks: seen.size,
    skipped,
    stranded,
    missing,
    jobsCoverageStartMs,
    gradesRows: grades.rows,
    gradesCoverageStartMs: grades.coverageStartMs,
    newestGradeMs: grades.newestMs,
    gradesJournal: gradesText === null ? 'missing' : 'read',
  };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the grades landed since, the picks were deliberate operator state, or the cause is owner-side (credentials, billing, a protected gate, host scheduling or the pinned ops install itself) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is three journals: <runs>/selector/picks.jsonl — one {at, rank, id, repo, jobType, score, predictedValue, mergeRate, minutes, usage, basis, frictionId?} row per funded pick, appended by `phm select` (src/cli/select.ts, src/core/routing/selector.ts pickRecords); <runs>/metrics/jobs.jsonl — the fleet jobs ledger syncPickGrades folds into per-job merge/used/revert evidence (src/core/fleet/pick-grade-sync.ts foldPickGradeEvidence, whose coverageStartMs is the first dated row of the retained tail); and ~/.ashlr/picks/grades.jsonl under the OS home — one {pickId, window, gradedAt, predicted, realized, hit, features} row per (pick, window) grade, appended by runPickGrader (src/core/fleet/pick-grader.ts), which resolves grades under homedir()/.ashlr/picks independent of ASHLR_HOME, with the SGD-updated weights.json beside it. CONTRACT-SELECTOR.md documents the grading contract: each pick is graded 24h and 7d after `at`, a 7d grade with realized >= 0.5 closes the pick\'s friction_id ledger item with reason grader-7d — the only automatic close — and a pick whose window starts before the retained jobs tail\'s first dated row defers rather than scoring a partial window as a miss. `phm select --json` reports the pass\'s grading field (state, picks, newGrades, frictionClosed, line) and text mode prints the accuracy line on stderr; `phm select schedule` previews the hourly launchd agent ai.ashlr.phm.selector.';

const truncationNote = (lowerBound: boolean): string =>
  lowerBound ? ' A bounded journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const daysText = (days: readonly string[]): string => days.slice().sort().join(', ');

/** Per-window ungraded tallies across a cell, e.g. "2 at 24h and 3 at 7d". */
function windowTally(cells: readonly UngradedPickCell[]): string {
  const counts = new Map<GradeWindow, number>();
  for (const cell of cells) {
    for (const w of cell.windows) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return GRADE_WINDOW_IDS
    .filter((w) => (counts.get(w) ?? 0) > 0)
    .map((w) => `${counts.get(w)} at ${w}`)
    .join(' and ');
}

function pickExamples(cells: readonly UngradedPickCell[]): { shown: string[]; rest: number } {
  const sorted = cells.slice().sort((a, b) => a.pickedAtMs - b.pickedAtMs);
  const shown = sorted.slice(0, PROMPT_PICKS_MAX).map((c) => `'${fieldText(c.id)}' (funded ${c.utcDay})`);
  return { shown, rest: Math.max(0, sorted.length - shown.length) };
}

function strandedPrompt(fold: PickGradeBacklogFold, lowerBound: boolean): string {
  const { shown, rest } = pickExamples(fold.stranded);
  const days = [...new Set(fold.stranded.map((c) => c.utcDay))].sort();
  const friction = fold.stranded.filter((c) => c.friction).length;
  const oldest = fold.stranded.reduce((min, c) => Math.min(min, c.pickedAtMs), Number.POSITIVE_INFINITY);
  const covStart = isoOrNull(fold.jobsCoverageStartMs);
  const gradesCov = isoOrNull(fold.gradesCoverageStartMs);
  const newest = isoOrNull(fold.newestGradeMs);
  return [
    `Phantom's selector keeps funding picks whose grades can never be written — ${fold.stranded.length} funded pick(s) hold proven-ungraded window(s) (${windowTally(fold.stranded)}) inside the retained journals, across ${days.length} distinct UTC day(s) (${daysText(days)}); the oldest stranded pick was funded ${new Date(oldest).toISOString()}.`,
    '',
    `The retained picks tail held ${fold.picks} distinct funded pick(s)${fold.skipped > 0 ? ` (${fold.skipped} row(s) the grader's own parser rejects)` : ''}; ${fold.stranded.length} of them sit before the jobs tail's coverage and ${fold.missing.length} inside it. The retained jobs tail's first dated row is ${covStart ?? 'unparseable'} — every pick funded before it defers under the coverage guard, so its grades, its weight updates and, at 7d, its friction-ledger auto-close can never land. The grades journal ${fold.gradesJournal === 'missing' ? 'does not exist — no grade was ever recorded' : `holds ${fold.gradesRows} retained grade row(s)${gradesCov === null ? '' : ` from ${gradesCov}`}${newest === null ? '' : `, newest ${newest}`}`}.${truncationNote(lowerBound)}`,
    '',
    `Pick ids: ${shown.join('; ')}${rest > 0 ? `, and ${rest} more` : ''}.${friction > 0 ? ` ${friction} of the stranded pick(s) were friction-ledger-sourced — their items' only automatic close is the 7d grade that can no longer fire.` : ''}`,
    '',
    EVIDENCE,
    '',
    `The coverage guard is honest per pick — a partial window must never score as a miss — but the bound is finite while picks.jsonl is append-only, so once the fleet's jobs-ledger growth pushes funding times out of the retained tail the grading contract becomes dead machinery: grades.jsonl stops growing, weights.json freezes and grader-7d never fires again. Check whether the horizon is structurally shorter than the 7-day window — metrics/jobs.jsonl growth rate against the 16 MiB readLedgerTail bound in src/core/fleet/pick-grade-sync.ts — and decide the fix this repository owns: widen or specialize the bound, grade from a dedicated pick-evidence journal that does not share the fleet ledger's retention, or reduce what a window needs to prove. Verify against the live shape first: \`phm select --json\` reports grading.state/newGrades, and ~/.ashlr/picks/grades.jsonl vs <runs>/selector/picks.jsonl shows the same stall this fold counted. If the bound already reaches past every funded pick and the stranding traces to a one-off ledger rotation or writer burst — report no-change and name the evidence. Fix what lives here — the grading path in src/core/fleet/, the selector in src/core/routing/ or this fold — and keep ops-side ledger retention, the pinned dispatcher and host scheduling out of scope. ${NO_CHANGE}`,
  ].join('\n');
}

function missingPrompt(fold: PickGradeBacklogFold, lowerBound: boolean): string {
  const { shown, rest } = pickExamples(fold.missing);
  const days = [...new Set(fold.missing.map((c) => c.utcDay))].sort();
  const friction = fold.missing.filter((c) => c.friction).length;
  const covStart = isoOrNull(fold.jobsCoverageStartMs);
  const newest = isoOrNull(fold.newestGradeMs);
  return [
    `Phantom's selector keeps funding picks whose due grades never reach the grades journal — ${fold.missing.length} funded pick(s) hold proven-ungraded window(s) (${windowTally(fold.missing)}) even though the retained jobs tail still covers their funding times, across ${days.length} distinct UTC day(s) (${daysText(days)}).`,
    '',
    `The retained picks tail held ${fold.picks} distinct funded pick(s)${fold.skipped > 0 ? ` (${fold.skipped} row(s) the grader's own parser rejects)` : ''}; ${fold.missing.length} of them sit inside jobs-tail coverage (first dated row ${covStart ?? 'unparseable'}) with no grade row on record${fold.gradesJournal === 'missing' ? ' — the grades journal does not exist at all' : ` — the grades journal holds ${fold.gradesRows} retained row(s)${newest === null ? '' : `, newest ${newest}`}`}.${truncationNote(lowerBound)}`,
    '',
    `Pick ids: ${shown.join('; ')}${rest > 0 ? `, and ${rest} more` : ''}.${friction > 0 ? ` ${friction} of the ungraded pick(s) were friction-ledger-sourced — their items' only automatic close is the 7d grade that is not landing.` : ''}`,
    '',
    EVIDENCE,
    '',
    `syncPickGrades runs at the end of every non-dry \`phm select\` pass and never throws — ledger problems come back as state, write problems as 'error', both swallowed into the --json grading field and the stderr accuracy line. A pick whose window closed more than a day ago with full coverage and no grade means the pass is not reaching runPickGrader: check whether the launchd agent ai.ashlr.phm.selector is installed and loaded (\`phm select schedule\` previews it; --write installs without loading), whether \`phm select --json\` reports grading.state other than 'read' or newGrades stuck at 0, whether the picks tail the pass reads matches the one this fold read, and whether the grades append itself fails (path, permissions, disk). If the pass runs and grades land for newer picks while these stay ungraded, check gradePicks' done-set and the coverage interplay in src/core/fleet/pick-grader.ts. Fix what lives here — the select pass, the grader or the evidence path in this repository's src/ — and keep ops-side scheduling, credentials and the pinned install out of scope. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(bucket: Bucket, repo: string): string {
  return `pick-grade-${bucket}-${sha(`pick-grade:${bucket}:${repo.toLowerCase()}`)}`;
}

function makeItem(bucket: Bucket, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(bucket, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'pick-grading',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the pick grader's recurring coverage-stranded and
 * gradeable-but-ungraded picks. Total: any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function pickGradeBacklogItems(opts: PickGradeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds and the writer apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty
    // env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) return [];

    // The picks journal is the primary evidence: missing or unreadable
    // means nothing was funded or nothing can be read — never a cell.
    let picksText: string | null;
    let lowerBound = false;
    if (opts.picksText !== undefined) {
      picksText = opts.picksText;
    } else {
      const tail = await readLedgerTail(opts.picksPath ?? join(runsDir, 'selector', 'picks.jsonl'), PICK_GRADE_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      picksText = tail.text;
      lowerBound = tail.truncated === true;
    }
    if (picksText === null) return [];

    // The jobs ledger supplies the coverage horizon the guard applies —
    // the same foldPickGradeEvidence the sync runs, so coverageStartMs is
    // exactly what the grader sees. Withheld or unreadable, coverage is
    // unknowable and both cells stay silent.
    let jobsText: string | null;
    if (opts.jobsText !== undefined) {
      jobsText = opts.jobsText;
    } else {
      const tail = await readLedgerTail(opts.jobsPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE), PICK_GRADE_TAIL_BYTES);
      jobsText = tail.state === 'read' ? tail.text : null;
      if (tail.state === 'read' && tail.truncated === true) lowerBound = true;
    }
    if (jobsText === null) return [];
    const jobsCoverageStartMs = foldPickGradeEvidence(jobsText, nowMs).coverageStartMs;
    if (jobsCoverageStartMs === null) return [];

    // The grades journal: 'missing' is proven-empty (the writer's own
    // readGrades returns [] identically); 'unreadable'/'not-file' cannot
    // prove absence, so the source stays quiet rather than guessing. A
    // read journal whose retained rows carry no usable gradedAt likewise
    // cannot bound what aged out — the fold treats that as unproven.
    let gradesText: string | null;
    if (opts.gradesText !== undefined) {
      gradesText = opts.gradesText;
    } else {
      const tail = await readLedgerTail(opts.gradesPath ?? join(home, '.ashlr', 'picks', 'grades.jsonl'), PICK_GRADE_TAIL_BYTES);
      if (tail.state === 'missing') {
        gradesText = null;
      } else if (tail.state === 'read') {
        gradesText = tail.text;
        if (tail.truncated === true) lowerBound = true;
      } else {
        return [];
      }
    }

    const fold = foldPickGradeBacklog(picksText, gradesText, jobsCoverageStartMs, nowMs);
    if (fold.picks === 0) return [];

    const candidates: CloudBacklogItem[] = [];
    const strandedDays = new Set(fold.stranded.map((c) => c.utcDay));
    if (fold.stranded.length >= PICK_GRADE_MIN_PICKS && strandedDays.size >= PICK_GRADE_MIN_DAYS) {
      candidates.push(makeItem(
        'stranded',
        repo,
        `Selector pick grades keep starving on jobs-ledger coverage on ${repo}`,
        strandedPrompt(fold, lowerBound),
      ));
    }
    const missingDays = new Set(fold.missing.map((c) => c.utcDay));
    if (fold.missing.length >= PICK_GRADE_MIN_PICKS && missingDays.size >= PICK_GRADE_MIN_DAYS) {
      candidates.push(makeItem(
        'missing',
        repo,
        `Selector pick grades keep never landing on ${repo}`,
        missingPrompt(fold, lowerBound),
      ));
    }
    const limit = Math.max(0, Math.min(opts.limit ?? PICK_GRADE_BACKLOG_MAX_ITEMS, PICK_GRADE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
