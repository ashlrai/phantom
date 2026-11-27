/**
 * Self-heal cycle journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `runSelfHealCycle` (src/core/fleet/self-heal.ts) is the fleet's
 * always-on repair cadence: every producer-maintenance pass it rotates
 * through the enrolled repos, runs each repo's detected build/test
 * commands under a wall-clock budget, and queues one deduped heal
 * WorkItem per repo it finds broken. Until now the cycle's outcome
 * existed only inside the tick that ran it — `checkedRepos` fed the
 * backlog refresh and `selfHeal: true` landed in the tick summary, but
 * the rest of SelfHealCycleResult (which repos stayed broken, how many
 * heal items were proposed, how many enrolled repos the cycle never
 * reached, whether the budget ran out) was dropped on return. The
 * durable self-heal-queue.json records only the queued items — one
 * entry per broken repo, id-deduped — so it cannot show that detection
 * keeps finding the same repo broken cycle after cycle, and nothing
 * anywhere recorded that the rotation's tail is never health-checked.
 *
 * appendSelfHealCycleRow now writes one `fleet.self-heal-cycle.v1`
 * line per enrollment rotation to metrics/self-heal-cycles.jsonl under
 * the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), carrying
 * {at, enrolled, checked, broken[], brokenTotal, healProposed,
 * deferred?, budgetExhausted?}. runSelfHealCycleForRepos verification
 * re-checks of already-queued repos do not journal — they are
 * follow-ups on known breakage, not coverage evidence.
 *
 * selfHealCycleBacklogItems carries that journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling self-tick, tick-health
 * and bridge-heal sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no enrollment,
 *    process or network is touched. A missing, non-file or unreadable
 *    journal yields no items — unknown stays unknown, never a guessed
 *    tally — while a truncated tail still folds the retained rows with
 *    the prompts stating the counts as lower bounds.
 *  - Rows count only under the writer's contract: schema
 *    'fleet.self-heal-cycle.v1', a parseable `at`, non-negative safe
 *    integer enrolled/checked/brokenTotal/healProposed, a broken array
 *    of bounded path strings, checked + deferred === enrolled (the
 *    writer's own invariant: deferred is exactly the unreached tail),
 *    and deferred/budgetExhausted only in the writer's shapes.
 *    Malformed lines, foreign shapes and off-contract rows are
 *    skipped, never guessed.
 *  - Healthy cycles never emit: a rotation that checked every enrolled
 *    repo and found nothing broken is the machinery working. Only two
 *    cells are evidence — a rotation that deferred repos (the
 *    enrollment outgrew the cycle's wall-clock budget or the phase
 *    signal cut it short, so the tail is silently never checked), and
 *    a repo that keeps landing in broken[] across cycles (detection
 *    keeps failing it while its heal item dedupes to a single queue
 *    entry — either the heal never converges or the detection itself
 *    is stuck).
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window records
 *    reach SELF_HEAL_CYCLE_MIN_UNITS across SELF_HEAL_CYCLE_MIN_DAYS
 *    distinct UTC days — one unlucky cycle or a one-day burst stays
 *    quiet. The window is anchored on the clock with the sibling
 *    feeds' future-skew allowance.
 *  - The evidence describes this install's fleet machinery — the
 *    journal has no owner/name column, only checkout paths. Broken
 *    paths are resolved read-only through repoIdentityOfPath for
 *    display; an unresolvable checkout is named by basename and never
 *    fabricated into an owner/name. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids key on the cell — the fixed
 *    deferred cell, or a hash of the broken checkout path — never the
 *    counts or timestamps, so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a repo that
 *    verifies green or a rotation that stops deferring simply stops
 *    re-adding.
 *  - Every journal string is untrusted text: checkout paths are
 *    flattened, scrubbed and capped before they reach a prompt, and
 *    the path is hashed into the item id so raw text never becomes an
 *    identifier.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { repoIdentityOfPath } from '../fleet/repo-identity.js';
import { SELF_HEAL_CYCLE_SCHEMA } from '../fleet/self-heal.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the deferred cell plus the recurring broken repos. */
export const SELF_HEAL_CYCLE_BACKLOG_MAX_ITEMS = 8;
const SELF_HEAL_CYCLE_ITEM_HARD_MAX = 12;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const SELF_HEAL_CYCLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const SELF_HEAL_CYCLE_FUTURE_SKEW_MS = 60_000;
/** In-window records a cell needs before its outcome counts as recurring. */
export const SELF_HEAL_CYCLE_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const SELF_HEAL_CYCLE_MIN_DAYS = 2;
/**
 * Bounded tail for the journal; a rotation row is a few hundred bytes,
 * so 1 MiB retains thousands of cycles — far more than the window needs
 * at any realistic maintenance cadence.
 */
const SELF_HEAL_CYCLE_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** A checkout path longer than this is not the writer's contract. */
const PATH_MAX = 1024;
/** The fleet's own repository label: self-heal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

type CellKind = 'cycle-deferred' | 'repo-broken';

export interface SelfHealCycleItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/self-heal-cycles.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SELF_HEAL_CYCLE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default SELF_HEAL_CYCLE_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated cycle record inside the evidence window. */
export interface SelfHealCycleRecord {
  atMs: number;
  utcDay: string;
  enrolled: number;
  checked: number;
  broken: string[];
  brokenTotal: number;
  healProposed: number;
  deferred: number;
  budgetExhausted: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const countField = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Pure: validate one parsed ledger line against the writer's row
 * contract. The schema stamp, a parseable `at`, the four count fields
 * and the broken-path list must all hold, and checked + deferred must
 * equal enrolled — the writer derives deferred as exactly the
 * unreached tail, so a row that breaks the invariant is not this
 * contract's evidence. Anything else is skipped, never guessed.
 */
export function parseSelfHealCycleRecord(value: unknown): SelfHealCycleRecord | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== SELF_HEAL_CYCLE_SCHEMA) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const enrolled = countField(value['enrolled']);
  const checked = countField(value['checked']);
  const brokenTotal = countField(value['brokenTotal']);
  const healProposed = countField(value['healProposed']);
  if (enrolled === null || checked === null || brokenTotal === null || healProposed === null) return null;
  const deferredRaw = value['deferred'];
  const deferred = deferredRaw === undefined ? 0 : countField(deferredRaw);
  if (deferred === null) return null;
  const budgetRaw = value['budgetExhausted'];
  if (budgetRaw !== undefined && typeof budgetRaw !== 'boolean') return null;
  const brokenRaw = value['broken'];
  if (!Array.isArray(brokenRaw)) return null;
  const broken: string[] = [];
  for (const entry of brokenRaw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || trimmed.length > PATH_MAX) continue;
    broken.push(trimmed);
  }
  // The writer's invariants: deferred is exactly the unreached tail,
  // and brokenTotal counts every broken repo the capped list came from.
  if (checked + deferred !== enrolled) return null;
  if (brokenTotal < broken.length) return null;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    enrolled,
    checked,
    broken,
    brokenTotal,
    healProposed,
    deferred,
    budgetExhausted: budgetRaw === true,
  };
}

/**
 * Pure: parse journal text into validated records plus the count of
 * lines that were not on-contract records — malformed JSON, foreign
 * shapes and off-contract rows are counted, never guessed.
 */
export function parseSelfHealCycleJournal(text: string): { records: SelfHealCycleRecord[]; invalidRows: number } {
  const records: SelfHealCycleRecord[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const record = parseSelfHealCycleRecord(value);
    if (record === null) { invalidRows += 1; continue; }
    records.push(record);
  }
  return { records, invalidRows };
}

/** One evidence cell's recurring tally across the in-window records. */
interface SelfHealCycleCell {
  kind: CellKind;
  /** Stable cell key: dedupes the fold and orders the emission. */
  key: string;
  /** Display name — the fixed deferred cell or the broken checkout path. */
  name: string;
  /** Records carrying this cell inside the window. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Deferred rows only: repos left unchecked summed across those rows. */
  deferredTotal: number;
  /** Deferred rows only: rows that stopped on the wall-clock budget. */
  budgetExhaustedUnits: number;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function cellFor(cells: Map<string, SelfHealCycleCell>, kind: CellKind, key: string, name: string): SelfHealCycleCell {
  let cell = cells.get(key);
  if (cell === undefined) {
    cell = { kind, key, name, units: 0, days: new Set(), deferredTotal: 0, budgetExhaustedUnits: 0, firstAtMs: Infinity, lastAtMs: -Infinity };
    cells.set(key, cell);
  }
  return cell;
}

function touch(cell: SelfHealCycleCell, record: SelfHealCycleRecord): void {
  cell.units += 1;
  cell.days.add(record.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, record.atMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, record.atMs);
}

/**
 * Pure: fold validated in-window records into per-cell tallies. Only
 * the writer's adverse vocabulary counts: rotations that deferred
 * enrolled repos, and checkout paths recurring in broken[]. Clean
 * rotations — every enrolled repo checked, nothing broken — are the
 * machinery working and never emit.
 */
export function foldSelfHealCycleEvidence(
  records: readonly SelfHealCycleRecord[],
  opts: { nowMs: number; windowMs?: number },
): { cells: SelfHealCycleCell[]; records: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? SELF_HEAL_CYCLE_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, SelfHealCycleCell>();
  let inWindow = 0;
  let outsideWindow = 0;
  for (const record of records) {
    if (record.atMs < windowStart || record.atMs > opts.nowMs + SELF_HEAL_CYCLE_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (record.deferred > 0) {
      const cell = cellFor(cells, 'cycle-deferred', 'deferred', '');
      touch(cell, record);
      cell.deferredTotal += record.deferred;
      if (record.budgetExhausted) cell.budgetExhaustedUnits += 1;
    }
    for (const repoPath of record.broken) {
      const cell = cellFor(cells, 'repo-broken', `broken:${repoPath}`, repoPath);
      touch(cell, record);
    }
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= SELF_HEAL_CYCLE_MIN_UNITS && cell.days.size >= SELF_HEAL_CYCLE_MIN_DAYS)
    .sort((a, b) => b.units - a.units || a.key.localeCompare(b.key));
  return { cells: recurring, records: inWindow, outsideWindow };
}

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/self-heal-cycles.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema fleet.self-heal-cycle.v1 — one row per `runSelfHealCycle` enrollment rotation appended by appendSelfHealCycleRow in src/core/fleet/self-heal.ts, carrying enrolled/checked counts, the broken checkout paths, healProposed, deferred and budgetExhausted. runSelfHealCycleForRepos verification re-checks do not journal. Until now the cycle result evaporated after each tick: only checkedRepos fed the backlog refresh and `selfHeal: true` reached the tick summary, while self-heal-queue.json keeps one deduped entry per broken repo — so persistent breakage and unreached enrollment tails left no durable trace.';

const NO_CHANGE = 'If the window has rolled forward, the deferred tail or the broken repo recovered on later cycles, the heal work for the named repo is already queued and landing, or the cause is enrolled-repo-side (its own build, tests or dependencies) or ops machinery rather than this repo — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} records outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function cellCounts(cell: SelfHealCycleCell): string {
  return `${cell.units} in-window cycles across ${cell.days.size} UTC days`;
}

/** Display name for a broken checkout path: proven owner/name, else basename, else unknown — never fabricated. */
function repoDisplayName(repoPath: string): string {
  try {
    const identity = repoIdentityOfPath(repoPath);
    if (identity !== null && identity !== '') return fieldText(identity, 80);
  } catch {
    // Identity resolution is best-effort; the basename still names the checkout.
  }
  const base = basename(repoPath);
  return base !== '' ? fieldText(base, 80) : 'unknown checkout';
}

function deferredPrompt(cell: SelfHealCycleCell, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const avg = Math.round(cell.deferredTotal / cell.units);
  const budgetNote = cell.budgetExhaustedUnits === cell.units
    ? 'every one of them stopped on the wall-clock budget'
    : cell.budgetExhaustedUnits > 0
      ? `${cell.budgetExhaustedUnits} of them stopped on the wall-clock budget`
      : 'none recorded the wall-clock budget as the cause — the phase signal or an early exit cut them';
  return [
    `Phantom's self-heal cycle keeps leaving enrolled repos unchecked — ${cellCounts(cell)} inside the window deferred repos the rotation never reached (about ${avg} per cycle), the self-improvement work this backlog exists for.`,
    '',
    `runSelfHealCycle rotates through every enrolled repo under SELF_HEAL_CYCLE_BUDGET_MS (2 minutes) with SELF_HEAL_MIN_REPO_BUDGET_MS (15 seconds) reserved per repo; a cycle that cannot finish records deferred = the unreached tail and budgetExhausted when the wall clock ran out, and the cursor resumes there next pass. Deferred repos are silently never health-checked: no breakage detection, no heal proposals, no queue entries — the coverage gap itself is the finding.${spanText(cell.firstAtMs, cell.lastAtMs)} ${budgetNote}.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find why the rotation cannot cover the enrollment: count the enrolled repos and their per-repo verify cost against the 2-minute cycle budget (detectBreakage runs each repo's detected build/test commands in src/core/fleet/self-heal.ts), or whether cycles are being cut short by the tick phase signal rather than the budget. If the enrollment is deliberately larger than one cycle can cover and the cursor is making steady forward progress — the design absorbs that — or the deferred repos are all parked/enrolled-by-accident rather than live work, report no-change and name the measurement. ${NO_CHANGE}`,
  ].join('\n');
}

function brokenPrompt(cell: SelfHealCycleCell, repoName: string, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const path = fieldText(cell.name, PATH_MAX);
  return [
    `Phantom's self-heal keeps finding '${repoName}' broken — ${cellCounts(cell)} inside the window recorded it in broken[], the self-improvement work this backlog exists for.`,
    '',
    `Each cycle that detects breakage proposes a heal WorkItem, but queueSelfHealItemDetailed dedupes by item id — a repo that stays broken produces one queue entry refreshed each cycle, not a growing pile. Recurring broken[] rows therefore mean one of three things: the queued heal is not being claimed or is not converging, the repo re-breaks after each heal, or detectBreakage's verdict itself is stuck (a verify command that can never pass, a detection contract drift).${spanText(cell.firstAtMs, cell.lastAtMs)} The checkout path recorded is '${path}'.${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `Find which of the three it is: check the repo's self-heal queue entry and its job outcomes in metrics/jobs.jsonl (claimed, finished, reverted?), then run the repo's detected verify commands against its checkout to see whether the breakage is real and current. If the repo is genuinely broken and its heal work is already queued and progressing, or the breakage is the enrolled repo's own code rather than Phantom machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellSlug(cell: SelfHealCycleCell): string {
  return cell.kind === 'cycle-deferred'
    ? 'deferred'
    : `broken-${createHash('sha256').update(cell.name).digest('hex').slice(0, 12)}`;
}

function cellTitle(cell: SelfHealCycleCell, repoName: string): string {
  return cell.kind === 'cycle-deferred'
    ? 'Self-heal cycle keeps leaving enrolled repos unchecked'
    : `Self-heal keeps finding '${repoName}' broken`;
}

function selfHealCycleItem(cell: SelfHealCycleCell, repo: string, truncated: boolean, invalidRows: number, outsideWindow: number): CloudBacklogItem {
  const repoName = cell.kind === 'repo-broken' ? repoDisplayName(cell.name) : '';
  const prompt = cell.kind === 'cycle-deferred'
    ? deferredPrompt(cell, truncated, invalidRows, outsideWindow)
    : brokenPrompt(cell, repoName, truncated, invalidRows, outsideWindow);
  return {
    id: `selfhealcycle-${cellSlug(cell)}`,
    title: cellTitle(cell, repoName).slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'fleet-self-heal',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the self-heal cycle journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function selfHealCycleBacklogItems(opts: SelfHealCycleItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value
    // is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, 'metrics', 'self-heal-cycles.jsonl'), SELF_HEAL_CYCLE_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const { records, invalidRows } = parseSelfHealCycleJournal(ledger.text);
    const folded = foldSelfHealCycleEvidence(records, { nowMs, windowMs: opts.windowMs });
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(selfHealCycleItem(cell, repo, ledger.truncated, invalidRows, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? SELF_HEAL_CYCLE_BACKLOG_MAX_ITEMS, SELF_HEAL_CYCLE_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
