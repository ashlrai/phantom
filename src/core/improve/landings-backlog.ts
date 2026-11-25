/**
 * Devin landings ledger recurring adverse publish and auto-merge
 * outcomes → self-improvement backlog items.
 *
 * `phm devin land` and every `phm devin autoland` apply pass that
 * reaches the publish step run landDevinSession
 * (src/core/devin/land.ts): it downloads the session's bundle,
 * verifies and rebases it onto the base branch, writes the job
 * records publish.sh reads, runs the fork-only publish, then — only
 * when a PR URL came back — decides whether to arm auto-merge. One
 * row per mechanically completed run is appended to
 * `devin/landings.jsonl` under the Ashlr home (DEVIN_LAND_LEDGER_FILE):
 * {v:1, kind:'devin-land', at, sessionId, repo, job, branch, base,
 * mergeBase, tip, commits, bundleSha256, result, pr, autoMerge,
 * taskId} — `result` the first words of publish.sh's last RESULT
 * line, `pr` the opened pull URL or null, `autoMerge` the arm
 * outcome ({armed, detail, reasonCode?}) or null.
 *
 * Until now the ledger's only reader was the autoland pass itself:
 * landings rows feed its already-landed idempotency check (a prior
 * row with a string `pr` for the session), and autoland-backlog
 * quotes the file inside its landing-failure prompt — but no reader
 * folded the window. autoland.jsonl records the pass's DECISIONS
 * ('land-failed', 'landed', gave-up…), and a 'landed' row carries
 * the autoMerge object only as a field on a success decision the
 * backlog never counts as adverse — so a PR that opened but could
 * not arm auto-merge, and every manual `phm devin land` publish
 * outcome (which never touches autoland.jsonl at all), looked like
 * ordinary rows in a file someone had to open, never work.
 *
 * landingsBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue
 * the recurring cells exactly like the sibling feeds beside it:
 *
 *  - publish-empty cells: `pr` is null and `result` begins
 *    'RESULT EMPTY' — publish.sh ran to completion but recorded
 *    that the verified bundle's commits produced nothing it would
 *    ship, so the land ended with no PR.
 *  - publish-refused cells: `pr` is null and `result` begins
 *    'RESULT ABORT' or 'RESULT DENIED' — the fork-only publish gates
 *    refused the job after the full mechanical land.
 *  - publish-unparsed cells: `pr` is null under any other recorded
 *    result — no RESULT line at all, or a RESULT head this fold does
 *    not recognize (including a 'RESULT PR' naming a different
 *    repository, which the writer's own regex refuses to record as
 *    `pr`).
 *  - arm-refused cells: a PR opened but `autoMerge.reasonCode` is
 *    'arm-refused' — the publish result carried no usable head SHA,
 *    so land.ts deliberately left the arm to "the next guarded
 *    pass" that the autoland loop never runs for arming.
 *  - gh-merge-failed cells: a PR opened but the recorded
 *    `autoMerge.detail` begins 'gh pr merge failed' — the
 *    `gh pr merge --auto --squash --match-head-commit` call itself
 *    errored.
 *  - merge-unclassified cells: `autoMerge.armed` is false under a
 *    detail outside the known designed holds and the two failure
 *    signatures — a newer writer's hold reason or failure shape
 *    this fold does not know; the recorded detail is quoted bounded.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through the bounded,
 *    no-follow tail read every sibling feed shares; nothing is
 *    written and no network is touched. A missing journal is a
 *    clean empty source; an unreadable or non-file read yields no
 *    items rather than folding partial evidence — unknown stays
 *    unknown — while a truncated tail still folds the retained
 *    rows with the prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: the object
 *    appendLedger emits — v:1, kind 'devin-land', a parseable `at`,
 *    a session id in the Devin pattern, an ashlrai/-owned repo
 *    label, job/branch/SHA fields in the writer's own shapes, a
 *    positive commit count, a 64-hex bundle digest, string `result`,
 *    `pr` a string or null, `autoMerge` null or the recorded
 *    {armed, detail, reasonCode?} shape, `taskId` a string or null.
 *    Malformed lines and off-contract rows are skipped and counted,
 *    never guessed.
 *  - Only mechanically completed runs exist here: landDevinSession
 *    appends after publish.sh exits, so throws before that point
 *    (API, bundle verify, rebase, commit-shape refusals) leave no
 *    row — those failures are autoland.jsonl's land-failed
 *    evidence, not this ledger's. A `pr`-null row still means the
 *    whole land path ran; it is the publish outcome itself that
 *    failed to produce a PR.
 *  - Designed holds never emit: `armed:false` rows whose detail is
 *    the sensitive-paths Security hold or a withheld
 *    'NOTE AUTO_MERGE' decision are publish.sh and land.ts working
 *    as designed, and `armed:true` rows are the arm succeeding —
 *    both count as context only.
 *  - Recurring means recorded across sessions and days: a cell
 *    emits only when its distinct session ids reach
 *    LANDINGS_MIN_UNITS AND span LANDINGS_MIN_DAYS distinct UTC
 *    days inside the window — one unlucky session never queues a
 *    session's worth of work, and a single bad hour never does
 *    either. Retried lands of one session share its id, so one
 *    session's retry storm is one unit.
 *  - Fleet machinery only: the journal describes this install's
 *    Devin land path — the row's `repo` names the publish TARGET
 *    (ashlrai/<repo>), never the machinery owner — so like the
 *    sibling autoland feed, items emit only when the backlog
 *    target's repository name is 'phantom'; the recorded target
 *    labels are quoted inside the cells instead.
 *  - Dedup is downstream. The item id hashes the cell kind, never
 *    the counts or timestamps, so a refresh re-derives the same id
 *    and appendUserBacklogItems adds only what is new; a cell that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the no-change escape names transient
 *    incidents, deliberate holds and owner-side causes, and the
 *    brief carries the reproduce steps.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import { DEVIN_LAND_LEDGER_FILE } from '../devin/land.js';
import { devinHome } from '../devin/store.js';
import { DEVIN_SESSION_ID_PATTERN } from '../devin/types.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is six kinds at most. */
export const LANDINGS_BACKLOG_MAX_ITEMS = 6;
const LANDINGS_ITEM_HARD_MAX = 25;
/**
 * Evidence window: lands are rare — a handful of apply runs a day at
 * most — so the sibling feeds' 7-day convention gives recurring
 * patterns room without letting stale evidence linger.
 */
export const LANDINGS_WINDOW_HOURS = 168;
/** Bounded tail for the journal; a row is ~400-800 bytes so this covers thousands of lands. */
const LANDINGS_TAIL_BYTES = 256 * 1024;
/** Distinct sessions one cell needs inside the window before its recurrence counts. */
export const LANDINGS_MIN_UNITS = 3;
/** Distinct UTC days the units must span — recurring means recorded across days. */
export const LANDINGS_MIN_DAYS = 2;
/** Future-skew allowance on row timestamps, same convention the sibling feeds tolerate. */
const LANDINGS_FUTURE_SKEW_MS = 60_000;
/** The fleet's own repository label: landings evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded identifiers and detail strings are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** autoMerge detail strings the writer caps near 200 chars; quoted shorter still. */
const MAX_DETAIL_CHARS = 160;
/** publish RESULT heads quoted inside prompts. */
const MAX_RESULT_CHARS = 120;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Example identifiers quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;

// The writer's own validation shapes (land.ts JOB_ID / BRANCH_NAME /
// SHA, duplicated for the same closure reason the sibling feeds
// duplicate their writers' vocabularies).
const JOB_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BUNDLE_SHA_RE = /^[0-9a-f]{64}$/;
const REPO_LABEL_RE = /^ashlrai\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** `pr` is the regex-matched pull URL or null; bounded text is enough — the fold never fetches it. */
const PR_URL_MAX = 200;

/**
 * The semantic failure classes the fold emits. `pr`-null rows split
 * by the recorded publish RESULT head because EMPTY, a gate refusal
 * and an unparsed outcome are different root causes; armed:false
 * rows split by the recorded arm detail because a missing head SHA,
 * a gh failure and an unknown hold are different root causes too.
 */
export type LandingsCellKind =
  | 'publish-empty'
  | 'publish-refused'
  | 'publish-unparsed'
  | 'arm-refused'
  | 'gh-merge-failed'
  | 'merge-unclassified';

export interface LandingsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal path override (default: join(devinHome(), DEVIN_LAND_LEDGER_FILE)). */
  journalPath?: string;
  /** Evidence window in hours (default LANDINGS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default LANDINGS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window, ms epoch (default: now). */
  now?: number;
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** First-seen-order, deduped-on-display-text, capped quote list. */
const pushQuoted = (list: string[], value: string | null): void => {
  if (value === null || value === '' || list.length >= MAX_EXAMPLES || list.includes(value)) return;
  list.push(value);
};

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded single-line text in the writer's identity shapes; '' never qualifies. */
function boundedText(value: unknown, re: RegExp): value is string {
  return typeof value === 'string' && re.test(value);
}

/** Optional bounded text: absent or a non-empty bounded string; anything else fails the contract. */
function optText(value: unknown, max: number): value is string | undefined {
  return value === undefined ||
    (typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value));
}

/** The publish RESULT head class a `pr`-null row records. */
function publishResultClass(result: string): 'empty' | 'refused' | 'other' {
  if (result.startsWith('RESULT EMPTY')) return 'empty';
  if (result.startsWith('RESULT ABORT') || result.startsWith('RESULT DENIED')) return 'refused';
  return 'other';
}

/** The autoMerge detail prefixes that are designed holds, never adverse evidence. */
function designedMergeHold(detail: string): boolean {
  return detail.startsWith('publish.sh flagged sensitive paths') || detail.startsWith('NOTE AUTO_MERGE');
}

/**
 * One journal row under the writer's contract: a ParsedLandingsRow
 * for a mechanically completed land, or null for a contract
 * violation. Every field appendLedger emits is checked; unknown
 * extra fields are ignored so a newer writer stays readable.
 */
export interface ParsedLandingsRow {
  kind: LandingsCellKind | null;
  atMs: number;
  /** Recurrence unit: the Devin session the land ran for. */
  unit: string;
  sessionId: string;
  job: string;
  /** Publish target label as recorded ('ashlrai/<repo>'). */
  repo: string;
  /** Recorded publish RESULT head, bounded. */
  result: string;
  /** The opened pull URL, or null on publish-* rows. */
  pr: string | null;
  /** Recorded autoMerge detail, bounded — merge cells only. */
  mergeDetail: string | null;
}

function parseLandingsRow(row: unknown): ParsedLandingsRow | null {
  if (!isRecord(row)) return null;
  if (row['v'] !== 1 || row['kind'] !== 'devin-land') return null;
  const atMs = parseLedgerTs(row['at']);
  if (atMs === null) return null;
  const sessionId = row['sessionId'];
  if (!boundedText(sessionId, DEVIN_SESSION_ID_PATTERN)) return null;
  const repo = row['repo'];
  if (!boundedText(repo, REPO_LABEL_RE)) return null;
  const job = row['job'];
  if (!boundedText(job, JOB_ID_RE)) return null;
  if (!boundedText(row['branch'], BRANCH_RE)) return null;
  if (!boundedText(row['base'], SHA_RE) || !boundedText(row['mergeBase'], SHA_RE) || !boundedText(row['tip'], SHA_RE)) return null;
  const commits = row['commits'];
  if (typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits < 1) return null;
  if (!boundedText(row['bundleSha256'], BUNDLE_SHA_RE)) return null;
  const result = row['result'];
  if (typeof result !== 'string' || result.length > 500) return null;
  const pr = row['pr'];
  if (!(pr === null || (typeof pr === 'string' && pr.length >= 1 && pr.length <= PR_URL_MAX && !/[\r\n]/.test(pr)))) return null;
  const autoMerge = row['autoMerge'];
  let mergeDetail: string | null = null;
  if (autoMerge !== null) {
    if (!isRecord(autoMerge) || typeof autoMerge['armed'] !== 'boolean') return null;
    const detail = autoMerge['detail'];
    if (typeof detail !== 'string' || detail.length < 1 || detail.length > 400 || /[\r\n]/.test(detail)) return null;
    const reasonCode = autoMerge['reasonCode'];
    if (!(reasonCode === undefined || (typeof reasonCode === 'string' && reasonCode.length >= 1 && reasonCode.length <= 60 && !/[\r\n]/.test(reasonCode)))) return null;
    if (autoMerge['armed'] === false) mergeDetail = detail;
  }
  if (!(row['taskId'] === null || optText(row['taskId'], 120))) return null;

  // Classify: a null `pr` is always a publish-* cell (autoMerge is
  // only recorded when a PR opened); a recorded armed:false
  // autoMerge splits by its detail vocabulary.
  let kind: LandingsCellKind | null = null;
  if (pr === null) {
    const resultClass = publishResultClass(result);
    kind = resultClass === 'empty' ? 'publish-empty'
      : resultClass === 'refused' ? 'publish-refused'
      : 'publish-unparsed';
  } else if (mergeDetail !== null) {
    const detail = mergeDetail;
    const reasonCode = isRecord(autoMerge) ? autoMerge['reasonCode'] : undefined;
    if (reasonCode === 'arm-refused') kind = 'arm-refused';
    else if (detail.startsWith('gh pr merge failed')) kind = 'gh-merge-failed';
    else if (!designedMergeHold(detail)) kind = 'merge-unclassified';
  }
  return {
    kind,
    atMs,
    unit: sessionId,
    sessionId,
    job,
    repo,
    result,
    pr,
    mergeDetail,
  };
}

/**
 * Pure: fold a journal tail into in-window rows plus the count of
 * lines that were not on-contract records — malformed JSON and
 * contract violations are counted, never guessed. Rows outside the
 * window or classifying as context (healthy lands and designed
 * holds) still parse; the caller's cell fold decides what counts.
 */
export function foldLandingsRows(
  text: string,
  cutoffMs: number,
  nowMs: number,
): { rows: ParsedLandingsRow[]; invalid: number } {
  const out: ParsedLandingsRow[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { invalid += 1; continue; }
    const parsed = parseLandingsRow(row);
    if (parsed === null) { invalid += 1; continue; }
    if (parsed.atMs < cutoffMs || parsed.atMs > nowMs + LANDINGS_FUTURE_SKEW_MS) continue;
    out.push(parsed);
  }
  return { rows: out, invalid };
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** Per-kind in-window fold before the recurring bars apply. */
export interface LandingsKindFold {
  kind: LandingsCellKind;
  /** Adverse rows recorded for the kind. */
  rows: number;
  /** Distinct recurrence units (Devin sessions). */
  units: Set<string>;
  /** Distinct UTC days the rows landed on. */
  days: Set<string>;
  /** Recorded publish-target labels ('ashlrai/<repo>'), most frequent first is applied later. */
  repos: Map<string, number>;
  /** Up to MAX_EXAMPLES session ids, first-seen order. */
  sessions: string[];
  /** Up to MAX_EXAMPLES job ids, first-seen order. */
  jobs: string[];
  /** Up to MAX_EXAMPLES recorded publish RESULT heads, first-seen order (publish-* kinds). */
  results: string[];
  /** Up to MAX_EXAMPLES recorded pull URLs, first-seen order (merge kinds). */
  prs: string[];
  /** Up to MAX_EXAMPLES recorded autoMerge details, first-seen order (merge kinds). */
  details: string[];
  /** ISO bounds of the rows; null when the kind recorded none. */
  firstMs: number | null;
  lastMs: number | null;
}

const emptyKindFold = (kind: LandingsCellKind): LandingsKindFold => ({
  kind, rows: 0, units: new Set(), days: new Set(), repos: new Map(),
  sessions: [], jobs: [], results: [], prs: [], details: [], firstMs: null, lastMs: null,
});

/**
 * Pure: fold validated rows into per-kind cells. Only rows carrying
 * an adverse classification contribute — context rows (healthy
 * lands, armed merges, designed holds) arrive with kind null and
 * are skipped here.
 */
export function foldLandingsCells(rows: readonly ParsedLandingsRow[]): LandingsKindFold[] {
  const folds = new Map<LandingsCellKind, LandingsKindFold>();
  for (const row of rows) {
    if (row.kind === null) continue;
    let cell = folds.get(row.kind);
    if (cell === undefined) {
      cell = emptyKindFold(row.kind);
      folds.set(row.kind, cell);
    }
    cell.rows += 1;
    cell.units.add(row.unit);
    cell.days.add(dayOf(row.atMs));
    const repo = fieldText(row.repo, MAX_FIELD_CHARS);
    if (repo !== '') cell.repos.set(repo, (cell.repos.get(repo) ?? 0) + 1);
    pushQuoted(cell.sessions, fieldText(row.sessionId));
    pushQuoted(cell.jobs, fieldText(row.job));
    if (row.pr === null) {
      pushQuoted(cell.results, row.result === '' ? '(no RESULT line)' : fieldText(row.result, MAX_RESULT_CHARS));
    } else {
      pushQuoted(cell.prs, fieldText(row.pr, MAX_FIELD_CHARS));
      pushQuoted(cell.details, row.mergeDetail === null ? null : fieldText(row.mergeDetail, MAX_DETAIL_CHARS));
    }
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...folds.values()];
}

/** One emitted cell: the kind plus the recorded detail the prompt quotes. */
export interface LandingsCell {
  kind: LandingsCellKind;
  /** Adverse rows recorded for the kind inside the window. */
  rows: number;
  /** Distinct sessions behind those rows. */
  units: number;
  /** Sorted distinct UTC days the rows landed on. */
  days: string[];
  /** Top recorded publish-target labels, most frequent first (capped). */
  repos: { text: string; count: number }[];
  /** Up to MAX_EXAMPLES session ids, first-seen order. */
  sessions: string[];
  /** Up to MAX_EXAMPLES job ids, first-seen order. */
  jobs: string[];
  /** Up to MAX_EXAMPLES recorded publish RESULT heads (publish-* kinds). */
  results: string[];
  /** Up to MAX_EXAMPLES recorded pull URLs (merge kinds). */
  prs: string[];
  /** Up to MAX_EXAMPLES recorded autoMerge details (merge kinds). */
  details: string[];
  /** ISO bounds of the rows. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
  /** Lines the tail read could not fold to the writer's contract — a recorded floor note. */
  invalid: number;
}

/**
 * Pure: the recurring cells the fold justifies — kinds whose
 * distinct sessions reach LANDINGS_MIN_UNITS across
 * LANDINGS_MIN_DAYS distinct UTC days. Sorted by row count, worst
 * first.
 */
export function landingsCells(folds: readonly LandingsKindFold[], opts: { lowerBound?: boolean; invalid?: number } = {}): LandingsCell[] {
  const cells: LandingsCell[] = [];
  for (const cell of folds) {
    if (cell.units.size < LANDINGS_MIN_UNITS || cell.days.size < LANDINGS_MIN_DAYS) continue;
    cells.push({
      kind: cell.kind,
      rows: cell.rows,
      units: cell.units.size,
      days: [...cell.days].sort(),
      repos: [...cell.repos.entries()]
        .map(([text, count]) => ({ text, count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, MAX_EXAMPLES),
      sessions: [...cell.sessions],
      jobs: [...cell.jobs],
      results: [...cell.results],
      prs: [...cell.prs],
      details: [...cell.details],
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound: opts.lowerBound === true,
      invalid: Math.max(0, opts.invalid ?? 0),
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is devin/landings.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME), DEVIN_LAND_LEDGER_FILE — landDevinSession in src/core/devin/land.ts appends one row per mechanically completed land: every `phm devin autoland` apply pass that reaches publish (the resident daemon\'s autoland timer runs one every ten minutes while Devin is connected) and every manual `phm devin land --apply`. Rows carry {v:1, kind:\'devin-land\', at, sessionId, repo (the publish TARGET, ashlrai/<repo>), job, branch, base, mergeBase, tip, commits, bundleSha256, result (publish.sh\'s last RESULT head), pr (the opened pull URL or null), autoMerge ({armed, detail, reasonCode?} or null), taskId}. Throws before the publish step leave no row — those are autoland.jsonl\'s land-failed decisions. The file\'s only other read is the autoland pass\'s already-landed idempotency check; autoland-backlog quotes it inside its landing prompt but until this feed no reader folded the window.';

const NO_CHANGE = 'If the window has rolled forward, the outcomes were a transient gh/git/Devin API or publish-host incident the later rows recovered from, the publishes were deliberately refused or held by gates working as designed, the lane is paused or the connected key intentionally lacks the needed scope, or the cause is owner-side state only Mason can change — report no-change and name the evidence.';

const REPRO = 'Reproduce the fold by reading devin/landings.jsonl under the Ashlr home directly, keeping rows that satisfy the writer\'s contract ({v:1, kind:\'devin-land\', parseable at, Devin-pattern sessionId, ashlrai/-owned repo, job/branch/SHA shapes, positive commits, 64-hex bundleSha256, string result, pr string-or-null, autoMerge null-or-{armed,detail,reasonCode?}, taskId string-or-null}) whose `at` lands inside the window, then classifying: pr null by its RESULT head (EMPTY / ABORT|DENIED / other), autoMerge armed:false by reasonCode \'arm-refused\', detail prefix \'gh pr merge failed\', the designed holds (\'publish.sh flagged sensitive paths\', \'NOTE AUTO_MERGE\' withheld lines) as context, and anything else as unclassified. The writer and its publish/arm policy are src/core/devin/land.ts; the publish RESULT vocabulary is contrib/mac/publish.sh; the retry surface is src/core/devin/autoland.ts.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: LandingsCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const lowerBoundText = (cell: LandingsCell): string =>
  cell.lowerBound ? ' The journal\'s bounded tail cut older rows, so these counts cover only the retained window — a recorded floor, not the full stream.' : '';

const invalidText = (cell: LandingsCell): string =>
  cell.invalid > 0 ? ` ${cell.invalid} line(s) in the retained tail failed the writer's contract and were skipped, never guessed.` : '';

const reposText = (cell: LandingsCell): string => {
  if (cell.repos.length === 0) return '';
  const shown = cell.repos.map((r) => `${r.text} (${r.count})`).join(', ');
  return ` Publish targets recorded: ${shown}.`;
};

const WINDOW_DAYS = Math.round(LANDINGS_WINDOW_HOURS / 24);

const KIND_TITLE: Record<LandingsCellKind, string> = {
  'publish-empty': 'Devin landings keep publishing empty — no PR opened',
  'publish-refused': 'Devin landings keep being refused by publish.sh',
  'publish-unparsed': 'Devin landings keep finishing without a usable publish result',
  'arm-refused': 'Devin-landed PRs keep missing auto-merge for want of a head SHA',
  'gh-merge-failed': 'Devin-landed PRs keep failing the auto-merge arm call',
  'merge-unclassified': 'Devin-landed PRs keep staying unarmed under unknown hold details',
};

const KIND_LEAD: Record<LandingsCellKind, string> = {
  'publish-empty':
    'publish.sh ran to completion but recorded RESULT EMPTY — the verified bundle\'s commits produced no diff the publisher would ship, so the land ended with no PR',
  'publish-refused':
    'publish.sh ran to completion but recorded RESULT ABORT or RESULT DENIED — the fork-only publish gates refused the job after the full mechanical land',
  'publish-unparsed':
    'publish.sh ran to completion but recorded no recognizable RESULT line — or a RESULT head this fold does not know, including a RESULT PR naming a different repository — so whether a PR exists is unrecorded',
  'arm-refused':
    'the PR opened but auto-merge could not be armed: the publish result carried no usable head SHA, so land.ts recorded arm-refused and left the arm "to the next guarded pass" — a pass the autoland loop never runs for arming',
  'gh-merge-failed':
    'the PR opened but the recorded autoMerge detail begins \'gh pr merge failed\' — the `gh pr merge --auto --squash --match-head-commit` call itself errored, so auto-merge was never armed',
  'merge-unclassified':
    'the PR opened but autoMerge.armed is false under a detail outside the known designed holds (sensitive-paths Security hold, withheld NOTE AUTO_MERGE decisions) and the two failure signatures — a hold or failure shape this fold does not know',
};

const KIND_FIND: Record<LandingsCellKind, string> = {
  'publish-empty':
    `Find why Devin session bundles keep landing with nothing to publish: each row is one landDevinSession apply run whose bundle verified, rebased and produced job records, then publish.sh recorded RESULT EMPTY — the commits existed but the publisher found no shippable diff (the change may already be on the base branch, the rebase may have emptied it, or the session produced no real change). Check parsePublishResult and the RESULT EMPTY path in contrib/mac/publish.sh, whether land.ts's commit-count check (rev-list merge-base..tip) can pass while the publish diff is empty, and whether these sessions genuinely produced unlandable work — a producer-side prompt or attachment-contract gap this repo's Devin launch path owns.`,
  'publish-refused':
    `Find why Devin session bundles keep being refused by the fork-only publish gates: each row is one landDevinSession apply run that reached publish.sh, which recorded RESULT ABORT or RESULT DENIED — the job records were written and the publish ran, then a gate refused it. Check which publish.sh gate fires (the RESULT line head is quoted in the evidence), whether the refusal is a real policy decision recurring on legitimate Devin work — a gate misfiring on the land path's record shapes — or sessions whose content genuinely must not publish. land.ts's job-record contract (queue/run/<job>.line, .base, .body.md, <job>.prompt, BRIDGE_NOTES.md) and publish.sh's gate inputs are this repository's own machinery.`,
  'publish-unparsed':
    `Find why Devin session bundles keep finishing publish without a usable RESULT: each row is one landDevinSession apply run whose publish.sh invocation produced no recognizable RESULT line — the run may have crashed, timed out (PUBLISH_TIMEOUT_MS is 30 minutes), been killed, or printed a RESULT head this fold does not know (a RESULT PR naming a different repository never records as \`pr\`). Check the <job>.publish log convention (~/.ashlr-runs/<job>.publish) for what these runs actually printed, whether publish.sh exits without a RESULT on some failure paths, and whether the land path should treat a missing RESULT as a distinct failure class rather than folding it into "did not open a PR". land.ts's parsePublishResult and the publish invocation are this repository's own.`,
  'arm-refused':
    `Find why landed Devin PRs keep missing auto-merge for want of a head SHA: each row is one landDevinSession run whose publish.sh opened a PR but whose RESULT line carried no HEADSHA= the writer accepts, so land.ts recorded {armed:false, reasonCode:'arm-refused'} and left the arm "to the next guarded pass" — and no such pass exists for arming: autoland.ts's already-landed check archives the session without retrying the arm. Check parsePublishResult's HEADSHA capture against publish.sh's actual RESULT PR output, whether the SENS/HEADSHA ordering in the RESULT line can hide the SHA, and whether an unarmed landed PR has any retry path at all — if not, that is the gap this item exists for. The publish contract is contrib/mac/publish.sh; the arm decision is land.ts's autoMergeDecision.`,
  'gh-merge-failed':
    `Find why the auto-merge arm call keeps failing on landed Devin PRs: each row is one landDevinSession run whose publish.sh opened a PR with a usable head SHA, then \`gh pr merge --auto --squash --match-head-commit <sha>\` returned nonzero — the recorded detail quotes the scrubbed stderr head. Check the recorded details for a recurring gh failure class (auth scope on the connected account, merge-state conflicts, branch protection the auto-merge cannot satisfy, a wrong --repo or PR reference), whether autoland or any pass retries the arm after a 'landed' decision (it does not today), and whether the failure is transient host state or a broken invocation. The arm call and its inputs are land.ts's; the gh environment is this install's.`,
  'merge-unclassified':
    `Find why landed Devin PRs keep staying unarmed under hold details this fold does not know: each row is one landDevinSession run whose autoMerge.armed is false with a detail outside the designed holds (the sensitive-paths Security hold and withheld NOTE AUTO_MERGE decisions) and outside the arm-refused and gh-failure signatures — either a newer writer records hold reasons this fold has not learned, or an unknown failure shape is being recorded as a hold. The recorded detail is quoted bounded in the evidence; check land.ts's autoMergeDecision and the publish.sh NOTE AUTO_MERGE vocabulary for what these details actually are, and whether any of them is a real failure being misclassified as deliberate.`,
};

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

function landingsItem(cell: LandingsCell, repo: string): CloudBacklogItem {
  const kind = cell.kind;
  const unitText = `${cell.rows} adverse row(s) across ${cell.units} distinct session(s)`;
  const examples = kind.startsWith('publish-')
    ? ` Recorded RESULT heads: ${cell.results.map((r) => `'${r.slice(0, 80)}'`).join(', ') || 'none'}. Sessions: ${cell.sessions.join(', ') || 'none'}. Jobs: ${cell.jobs.join(', ') || 'none'}.`
    : ` Recorded PRs: ${cell.prs.join(', ') || 'none'}. Details: ${cell.details.map((d) => `'${d.slice(0, 100)}'`).join(', ') || 'none'}. Sessions: ${cell.sessions.join(', ') || 'none'}.`;
  // The hash covers the full cell identity (kind + repository); the
  // readable kind fragment keeps the id debuggable while staying
  // inside ID_RE's 120-char cap.
  const hash = sha(`landings:${repo.trim().toLowerCase()}:${kind}`);
  const id = `devin-landings-${idSafe(kind, 32)}-${hash}`;
  const prompt = [
    `Phantom's Devin landings ledger keeps recording ${KIND_LEAD[kind]} — ${unitText} and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one landDevinSession apply run recorded in devin/landings.jsonl.${examples}${reposText(cell)}${seenText(cell)}${lowerBoundText(cell)}${invalidText(cell)}`,
    '',
    EVIDENCE,
    '',
    KIND_FIND[kind],
    '',
    `If the window has rolled forward, the outcomes were a transient gh/git/Devin API or publish-host incident the later rows recovered from, the publishes were deliberately refused or held by gates working as designed, the lane is paused or the connected key intentionally lacks the needed scope, or the cause is owner-side state only Mason can change (the Keychain-held credential, Devin-side session configuration, billing) — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: KIND_TITLE[kind].slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'devin-landings',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Devin landings journal's recurring adverse
 * publish and auto-merge outcomes. Total: another repository, a
 * missing journal, an unreadable read or any fold failure yields no
 * items rather than throwing into discovery.
 */
export async function landingsBacklogItems(opts: LandingsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const journalPath = opts.journalPath ?? join(devinHome(), DEVIN_LAND_LEDGER_FILE);
    const nowMs = opts.now ?? Date.now();
    const cutoffMs = nowMs - (opts.windowHours ?? LANDINGS_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(journalPath, LANDINGS_TAIL_BYTES);
    // A missing journal is a clean empty source; an unreadable or
    // non-file read means evidence exists that cannot be trusted —
    // fail closed. A truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const { rows, invalid } = foldLandingsRows(tail.text, cutoffMs, nowMs);
    if (rows.length === 0) return [];
    const cells = landingsCells(foldLandingsCells(rows), { lowerBound: tail.truncated === true, invalid });
    const limit = Math.max(1, Math.min(opts.limit ?? LANDINGS_BACKLOG_MAX_ITEMS, LANDINGS_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => landingsItem(cell, repo));
  } catch {
    return [];
  }
}
