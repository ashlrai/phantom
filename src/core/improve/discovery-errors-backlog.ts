/**
 * Unattended discovery pass journal → self-improvement backlog items.
 *
 * autoDiscover (src/core/improve/discover.ts) runs discoverBacklog on the
 * cloud scheduler's improve job and receives { ran, added, errors } — one
 * errors[] entry per evidence feed that threw inside the feed() isolation
 * catch ('<feedName>: <message>'), per GitHub poll that failed
 * ('default branch checks: ...', 'issues: ...') and the hot-patch log
 * read. Until this journal existed the scheduler's improve job read only
 * `added`: the errors array was computed and dropped on the one path
 * that runs unattended, so a feed that started throwing went silent
 * forever — its items simply stopped being added while discovery kept
 * reporting success. `phm improve discover` printed the same errors as
 * warnings, but nobody runs it on a schedule.
 *
 * appendDiscoveryPass (src/core/improve/discovery-pass-journal.ts) now
 * appends one bounded {v:1, at, added, errors[]} row per pass that ran
 * discovery to <runsDir>/metrics/improve-discovery.jsonl.
 * discoveryErrorsBacklogItems folds that journal into discoverBacklog, so
 * a source whose reads keep failing becomes work — the same
 * degraded-evidence-becomes-work rule every sibling feed applies.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *  - Missing is a clean empty source: autoDiscover may legitimately never
 *    have run (self-improvement off, scheduler not started) — no rows is
 *    not proof of failure. An unreadable or non-file journal is
 *    different: the pass journal exists to make discovery health visible,
 *    so a journal that cannot be read emits the degraded-source item
 *    alone rather than a fold over evidence the strict reader refused.
 *  - Rows count only under the writer's contract: v:1, a parseable `at`,
 *    an `added` count that is a non-negative integer or null, and an
 *    `errors` array of bounded strings. Malformed lines are skipped and
 *    counted, never guessed.
 *  - Recurring means recorded across passes and days: a source emits
 *    only at DISCOVERY_ERRORS_MIN_PASSES passes carrying it across
 *    DISCOVERY_ERRORS_MIN_DAYS distinct UTC days inside the window, so
 *    one transient GitHub outage or one bad feed tick never queues a
 *    session.
 *  - The window anchors on each row's own `at` inside
 *    DISCOVERY_ERRORS_WINDOW_HOURS; rows whose timestamp cannot be parsed
 *    are counted as undated and reported, never silently folded.
 *  - Fleet machinery only: the journal describes this install's
 *    self-improvement discovery, which targets this repository's
 *    machinery — items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Dedup is downstream: the item id hashes the source key (the
 *    recorded '<source>' prefix — never counts or timestamps), so a
 *    refresh re-derives the same id and a recovered source simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';
import { DISCOVERY_PASS_JOURNAL_RELATIVE } from './discovery-pass-journal.js';

/** Items one call may emit; the source space is one cell per recorded error prefix. */
export const DISCOVERY_ERRORS_BACKLOG_MAX_ITEMS = 6;
const DISCOVERY_ERRORS_ITEM_HARD_MAX = 12;
/** A source emits only at this many passes carrying it inside the window... */
export const DISCOVERY_ERRORS_MIN_PASSES = 3;
/** ...across at least this many distinct UTC days. */
export const DISCOVERY_ERRORS_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const DISCOVERY_ERRORS_WINDOW_HOURS = 168;
/** Bounded tail read; ~4 rows/day keeps months of passes inside this. */
const DISCOVERY_ERRORS_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: discovery evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Longest recorded '<source>' prefix kept as a cell key. */
const MAX_SOURCE_CHARS = 80;
/** Example error lines quoted per cell inside one prompt. */
const MAX_EXAMPLE_ERRORS = 2;
/** Per-example character bound after scrubbing. */
const MAX_EXAMPLE_CHARS = 160;

export interface DiscoveryErrorsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/improve-discovery.jsonl; $ASHLR_RUNS_DIR wins when set and non-empty, else <home>/.ashlr-runs. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Journal override (default: join(runsDir, 'metrics', 'improve-discovery.jsonl')). */
  journalPath?: string;
  /** Evidence window in hours (default DISCOVERY_ERRORS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default DISCOVERY_ERRORS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Row contract — one pass row exactly as appendDiscoveryPass writes it
// ---------------------------------------------------------------------------

/** One projected pass row: the journal's {v:1, at, added, errors[]} flattened for the fold. */
export interface DiscoveryPassRow {
  atMs: number;
  /** Pass's appended-item count; null when the writer recorded unknown. */
  added: number | null;
  errors: string[];
}

/**
 * Structural validation of one persisted pass row against the writer's
 * contract: v:1, a parseable `at`, an `added` that is a non-negative
 * integer or null, and an `errors` array of bounded strings. Returns null
 * for a corrupted or foreign row so the caller counts it skipped rather
 * than let damaged evidence masquerade as a real pass. The fold re-checks
 * the same shape because injected readers are not trusted.
 */
function projectRow(value: unknown): DiscoveryPassRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['v'] !== 1) return null;
  if (typeof row['at'] !== 'string') return null;
  const atMs = Date.parse(row['at']);
  if (!Number.isFinite(atMs)) return null;
  const addedRaw = row['added'];
  const added = addedRaw === null ? null
    : typeof addedRaw === 'number' && Number.isSafeInteger(addedRaw) && addedRaw >= 0 ? addedRaw
    : undefined;
  if (added === undefined) return null;
  const errorsRaw = row['errors'];
  if (!Array.isArray(errorsRaw)) return null;
  const errors: string[] = [];
  for (const entry of errorsRaw) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048) return null;
    errors.push(entry);
  }
  return { atMs, added, errors };
}

/**
 * The recorded '<source>' a cell groups by: the error string's prefix
 * before the first ': ' — the feed() wrapper's name, the poll labels
 * ('default branch checks', 'issues') — or the bounded head of the string
 * itself when no ': ' prefix exists (the hot-patch row is a constant
 * sentence, so it still keys stably). Anything else is unattributed
 * noise that cannot recur into a cell.
 */
function sourceKey(error: string): string {
  const idx = error.indexOf(': ');
  const head = idx > 0 && idx <= MAX_SOURCE_CHARS ? error.slice(0, idx) : error.slice(0, MAX_SOURCE_CHARS);
  return head.trim();
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal's retained rows
// ---------------------------------------------------------------------------

interface SourceAccum {
  source: string;
  /** Passes (rows) carrying at least one error under this source. */
  passes: number;
  /** Total error entries recorded under this source. */
  occurrences: number;
  /** Distinct UTC days the carrying passes span. */
  days: Set<string>;
  /** Prompt-safe example error lines (scrubbed, bounded). */
  examples: string[];
  firstMs: number | null;
  lastMs: number | null;
  /** Latest pass's appended-item count; null when the row recorded unknown. */
  lastAdded: number | null;
}

export interface DiscoveryErrorsFold {
  /** Per-source accumulators for in-window pass rows. */
  sources: Map<string, SourceAccum>;
  /** Passes seen inside the window (rows with a usable timestamp). */
  passes: number;
  /** Passes whose errors array was non-empty. */
  passesWithErrors: number;
  /** Rows skipped for malformed shape or unparseable timestamp. */
  skippedRows: number;
  /** Rows outside the window — normal aging, counted for context only. */
  outOfWindow: number;
}

function accumFor(fold: DiscoveryErrorsFold, source: string): SourceAccum {
  let accum = fold.sources.get(source);
  if (accum === undefined) {
    accum = { source, passes: 0, occurrences: 0, days: new Set(), examples: [], firstMs: null, lastMs: null, lastAdded: null };
    fold.sources.set(source, accum);
  }
  return accum;
}

function exampleText(error: string): string {
  const scrubbed = scrubSecrets(error).replaceAll(homedir(), '~');
  return scrubbed.length > MAX_EXAMPLE_CHARS ? `${scrubbed.slice(0, MAX_EXAMPLE_CHARS - 1)}…` : scrubbed;
}

/**
 * Pure: fold pass rows — oldest first — into per-source error evidence
 * inside [nowMs - windowMs, nowMs]. A source counts once per pass row
 * that carries it (its errors are per-source unique by construction, but
 * the fold dedupes defensively); each distinct error entry adds to
 * occurrences. Rows outside the window are normal aging; rows whose
 * timestamp cannot be parsed are counted skipped, never guessed.
 */
export function foldDiscoveryErrors(rows: readonly DiscoveryPassRow[], nowMs: number, windowMs: number): DiscoveryErrorsFold {
  const fold: DiscoveryErrorsFold = { sources: new Map(), passes: 0, passesWithErrors: 0, skippedRows: 0, outOfWindow: 0 };
  for (const row of rows) {
    if (row.atMs > nowMs || row.atMs < nowMs - windowMs) { fold.outOfWindow++; continue; }
    fold.passes++;
    if (row.errors.length === 0) continue;
    fold.passesWithErrors++;
    const bySource = new Map<string, number>();
    for (const error of row.errors) {
      const key = sourceKey(error);
      if (key === '') continue;
      bySource.set(key, (bySource.get(key) ?? 0) + 1);
    }
    for (const [source, count] of bySource) {
      const accum = accumFor(fold, source);
      accum.passes++;
      accum.occurrences += count;
      accum.days.add(dayOf(row.atMs));
      accum.lastAdded = row.added;
      accum.firstMs = accum.firstMs === null ? row.atMs : Math.min(accum.firstMs, row.atMs);
      accum.lastMs = accum.lastMs === null ? row.atMs : Math.max(accum.lastMs, row.atMs);
      for (const error of row.errors) {
        if (sourceKey(error) !== source) continue;
        const text = exampleText(error);
        if (accum.examples.length < MAX_EXAMPLE_ERRORS && !accum.examples.includes(text)) accum.examples.push(text);
      }
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One recurring error source: a '<source>' prefix across passes and days. */
export interface DiscoveryErrorsCell {
  source: string;
  /** Passes carrying this source inside the window. */
  passes: number;
  /** Total error entries recorded under this source. */
  occurrences: number;
  /** Distinct UTC days the carrying passes span. */
  days: number;
  /** Up to MAX_EXAMPLE_ERRORS scrubbed example error lines. */
  examples: string[];
  /** The latest carrying pass's appended-item count; null when unknown. */
  lastAdded: number | null;
  /** ISO bounds of the cell's recorded passes; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Pure: the recurring bars one cell must clear — passes carrying the
 * source across distinct UTC days, the fleet's recurring-failure
 * convention applied to discovery health. At most one cell exists per
 * recorded source.
 */
export function discoveryErrorsCells(fold: DiscoveryErrorsFold): DiscoveryErrorsCell[] {
  const cells: DiscoveryErrorsCell[] = [];
  for (const accum of fold.sources.values()) {
    if (accum.passes < DISCOVERY_ERRORS_MIN_PASSES || accum.days.size < DISCOVERY_ERRORS_MIN_DAYS) continue;
    cells.push({
      source: accum.source,
      passes: accum.passes,
      occurrences: accum.occurrences,
      days: accum.days.size,
      examples: accum.examples,
      lastAdded: accum.lastAdded,
      firstSeen: isoOrNull(accum.firstMs),
      lastSeen: isoOrNull(accum.lastMs),
    });
  }
  return cells.sort((a, b) => b.occurrences - a.occurrences || a.source.localeCompare(b.source));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/metrics/improve-discovery.jsonl — appendDiscoveryPass in src/core/improve/discovery-pass-journal.ts writes one {v:1, at, added, errors[]} row per unattended discovery pass autoDiscover (src/core/improve/discover.ts) runs on the cloud scheduler\'s improve job; each errors[] entry is \'<source>: <message>\' from a discoverBacklog feed() isolation catch (the source is the feed function name, e.g. fleetLearningBacklogItems → src/core/improve/<name>-backlog.ts), a GitHub poll (\'default branch checks\', \'issues\') or the PHM_HOT_PATCH_LOG read. Until this feed the scheduler read only the pass\'s added count and dropped errors entirely — only `phm improve discover` printed them — so a feed that started throwing went silent forever while its items stopped being added.';

const NO_CHANGE = 'If the window has rolled forward the failures were a transient burst that has since stopped (a rotated journal, a GitHub outage, a pinned ops file mid-deploy), the source already recovers on retry, or the failing feed was retired — report no-change and name the evidence.';

function seenText(cell: DiscoveryErrorsCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function sourceKindText(source: string): string {
  if (source.endsWith('BacklogItems')) {
    return `a discoverBacklog evidence feed — the function lives in src/core/improve/discover.ts's feed wiring and the fold in the matching src/core/improve/*-backlog.ts module`;
  }
  if (source === 'default branch checks' || source === 'issues') {
    return 'a GitHub poll inside discoverBacklog (pollRedBranch / pollIssues in src/core/automations/github.js)';
  }
  if (source.startsWith('Could not read the hot-patch log')) {
    return 'the PHM_HOT_PATCH_LOG read inside autoDiscover (src/core/improve/hot-patch.ts)';
  }
  return 'a recorded discovery error source';
}

function cellPrompt(cell: DiscoveryErrorsCell, fold: DiscoveryErrorsFold, skippedRows: number, truncated: boolean): string {
  const examples = cell.examples.length === 0
    ? 'none recorded'
    : cell.examples.map((line) => `- ${line}`).join('\n');
  const addedText = cell.lastAdded === null ? 'unknown' : `${cell.lastAdded}`;
  const coverage = [
    truncated ? 'the journal tail was truncated — older passes are outside the read window' : null,
    skippedRows > 0 ? `${skippedRows} malformed row(s) skipped` : null,
  ].filter((s): s is string => s !== null).join('; ');
  return [
    `Phantom's unattended self-improvement discovery keeps recording failures for '${cell.source}' — ${sourceKindText(cell.source)} has errored on ${cell.passes} of the last ${fold.passes} recorded passes across ${cell.days} distinct UTC day(s) inside the ${DISCOVERY_ERRORS_WINDOW_HOURS}h window, so whatever it was reading has been dark while the loop kept running.`,
    '',
    `Recorded source: ${cell.source}. ${cell.occurrences} error entr${cell.occurrences === 1 ? 'y' : 'ies'} across ${cell.passes} pass(es); the latest carrying pass appended ${addedText} item(s).`,
    `Window: ${fold.passes} pass(es) recorded, ${fold.passesWithErrors} with at least one error, ${fold.outOfWindow} older row(s) aged out.${coverage === '' ? '' : ` Coverage: ${coverage}.`}${seenText(cell)}`,
    '',
    'Example recorded errors (scrubbed):',
    examples,
    '',
    `Find what '${cell.source}' reads and why it keeps failing: for a *BacklogItems feed, join the feed function in src/core/improve/discover.ts to its fold module and the journal it consumes — a feed that cannot read its evidence contributes nothing while looking healthy; for a poll, check the gh auth and API surface discoverBacklog uses; for the hot-patch row, check the PHM_HOT_PATCH_LOG path and writer. Fix the read path or the journal producer in this repository rather than muting the evidence. Run the affected suite. ${NO_CHANGE}`,
    '',
    EVIDENCE,
  ].join('\n');
}

function cellItem(cell: DiscoveryErrorsCell, fold: DiscoveryErrorsFold, skippedRows: number, truncated: boolean, repo: string): CloudBacklogItem {
  const title = `Discovery errors: '${cell.source}' keeps failing`.slice(0, MAX_TITLE_CHARS);
  return {
    id: `improve-discovery-${sha(`discovery-errors:${cell.source}`)}`,
    title,
    prompt: cellPrompt(cell, fold, skippedRows, truncated),
    area: 'improve-discovery',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The degraded-read item: the pass journal exists to make discovery health visible, so an unreadable one is itself work. */
function degradedItem(readState: string, repo: string): CloudBacklogItem {
  const prompt = [
    `Phantom's unattended discovery pass journal (${DISCOVERY_PASS_JOURNAL_RELATIVE} under the runs dir) could not be read — state '${readState}' — so recurring per-source discovery failures are unmeasurable and the discovery-errors feed is blind.`,
    '',
    'The journal is append-only evidence written by appendDiscoveryPass (src/core/improve/discovery-pass-journal.ts) inside autoDiscover; readLedgerTail refuses symlinks, non-regular files and unstable reads, so this state means the file is missing-readably broken — a directory at the path, a permission or custody failure, or a torn environment — not merely empty.',
    '',
    'Find why the journal cannot be read: check the runs dir resolution ($ASHLR_RUNS_DIR else ~/.ashlr-runs), the metrics/ directory, file ownership and mode (the writer opens 0600 O_APPEND|O_NOFOLLOW), and whether a foreign process replaced the file. If the journal was never created because self-improvement discovery has not run, report no-change — missing is a clean empty source and this item should not have fired.',
    '',
    EVIDENCE,
  ].join('\n');
  return {
    id: `improve-discovery-${sha(`discovery-errors:degraded:${readState}`)}`,
    title: 'Discovery pass journal is unreadable'.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'improve-discovery',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for recurring per-source failures in the unattended
 * discovery pass journal. Total: a missing journal yields no items (the
 * scheduler may legitimately never have run — a clean empty source), an
 * unreadable or non-file journal yields the degraded-source item alone,
 * and any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function discoveryErrorsBacklogItems(opts: DiscoveryErrorsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? (process.env['ASHLR_RUNS_DIR'] !== undefined && process.env['ASHLR_RUNS_DIR'] !== ''
      ? process.env['ASHLR_RUNS_DIR']
      : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, DISCOVERY_PASS_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours * 3_600_000
      : DISCOVERY_ERRORS_WINDOW_HOURS * 3_600_000;
    const tail = await readLedgerTail(journalPath, DISCOVERY_ERRORS_TAIL_BYTES);
    if (tail.state === 'missing') return [];
    if (tail.state !== 'read') return [degradedItem(tail.state, repo)];
    const rows: DiscoveryPassRow[] = [];
    let skippedRows = 0;
    for (const line of tail.text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { skippedRows++; continue; }
      const row = projectRow(parsed);
      if (row === null) { skippedRows++; continue; }
      rows.push(row);
    }
    const fold = foldDiscoveryErrors(rows, nowMs, windowMs);
    const cells = discoveryErrorsCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? DISCOVERY_ERRORS_BACKLOG_MAX_ITEMS, DISCOVERY_ERRORS_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cellItem(cell, fold, skippedRows, tail.truncated, repo));
  } catch {
    return [];
  }
}
