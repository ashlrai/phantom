/**
 * Job-reissue audit ledger → self-improvement backlog items.
 *
 * The Fleet Outcomes pane's Reissue button and POST
 * /api/verse/outcomes/fleet-reissue both end at reissueJob
 * (src/core/fleet/job-reissue.ts): it re-drops a finished job's prompt
 * under the next <stem>R<n> id through writeDropJob — the published
 * prompt lands as RQ-PHX-<to> under leader/drop/<lane>/ and ingests as
 * an ordinary job — and appends exactly one audit row to
 * queue/job-reissues.jsonl under the fleet runs directory:
 *
 *   {at, from, to, lane, tier, file}
 *
 * `from` is the RQ-PHX-… prompt id that was rescued, `to` the bare
 * <stem>R<n> id the drop writer published, lane/tier the recorded
 * placement, and `file` the absolute prompt path — local filesystem
 * text this feed never reads or quotes.
 *
 * Until now the ledger had no reader at all — not the router outcome
 * fold, not outcome learning, not any backlog source — so the fleet's
 * own record that operators kept rescuing the same job families never
 * became work: a job reissued over and over looked like unrelated
 * R-suffix generations scattered across jobs.jsonl with no link back
 * to the prompt that kept dying. jobReissueBacklogItems carries the
 * tail into discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue it exactly like the sibling
 * fleet-evidence feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. queue/job-reissues.jsonl is read once through
 *    readLedgerTail's bounded no-follow tail; nothing is written and
 *    no network is touched. A missing, unreadable or non-file ledger
 *    yields no items.
 *  - Writer-contract rows only. A row counts only when `from` matches
 *    the RQ-PHX- id shape reissueJob itself validates, `to` matches
 *    the drop writer's bare-id shape, and `at` parses inside the
 *    window under the shared ledger timestamp dialect. lane and tier
 *    are optional recorded strings — flattened, scrubbed and capped
 *    before they reach a prompt. `file` is never read: it is a local
 *    path. Malformed lines are skipped, never guessed.
 *  - Adverse means recorded rescue, never inferred outcome. Every
 *    counted row is one recorded decision that the job's prompt
 *    deserved another run — the ledger cannot see whether the rescue
 *    landed, so prompts direct sessions to join jobs.jsonl for the
 *    RQ-PHX-<to> generations' own finish/outcome rows rather than
 *    claiming failure this feed cannot prove.
 *  - The family key is the writer's own. nextReissueId strips the
 *    RQ-PHX- prefix and one trailing R<n> group to name the stem every
 *    generation shares, so this fold derives the same stem from `to`
 *    — reissues of reissues land in the family the writer minted.
 *  - Recurring means recorded across days. A family emits only at
 *    JOB_REISSUE_CHAIN_MIN_ROWS rescue rows spanning
 *    JOB_REISSUE_CHAIN_MIN_DAYS distinct UTC days inside the window —
 *    one deliberate re-run, or a same-day retry burst, never queues a
 *    session. A wave cell emits only at JOB_REISSUE_WAVE_MIN_STEMS
 *    distinct rescued families across JOB_REISSUE_WAVE_MIN_DAYS days —
 *    isolated rescues are routine ops, a broad rescue pattern is not.
 *  - Fleet machinery only. The ledger is this install's rescue record
 *    — it carries no repository column — so items emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence feeds apply.
 *  - Dedup is downstream. Item ids key on the cell identity — the
 *    family stem or the wave kind, never the counts or timestamps —
 *    so a refresh re-derives the same ids and appendUserBacklogItems
 *    adds only what is new; a family that stops needing rescue simply
 *    stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, lane/tier strings are scrubbed,
 *    flattened and capped, example ids must match the writer's own id
 *    shapes before they are quoted, a truncated tail is stated as a
 *    lower bound, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; chain cells are bounded by rescued-family diversity. */
export const JOB_REISSUE_MAX_ITEMS = 8;
const JOB_REISSUE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days — the recurring-flake/sibling convention for fleet-evidence feeds. */
export const JOB_REISSUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const JOB_REISSUE_FUTURE_SKEW_MS = 60_000;
/** Rescue rows one family needs inside the window before it counts as recurring. */
export const JOB_REISSUE_CHAIN_MIN_ROWS = 2;
/** Distinct UTC days those rows must span — recurring means across days, not one burst. */
export const JOB_REISSUE_CHAIN_MIN_DAYS = 2;
/** Distinct rescued families the wave cell needs inside the window. */
export const JOB_REISSUE_WAVE_MIN_STEMS = 3;
/** Distinct UTC days the wave's families must span. */
export const JOB_REISSUE_WAVE_MIN_DAYS = 2;
/** Bounded tail for the audit ledger; a row is a few hundred bytes so this covers thousands of rescues. */
const JOB_REISSUE_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/tier strings are ledger-recorded text; flatten, scrub and cap before they reach a prompt. */
const MAX_FIELD_CHARS = 80;
/** Distinct lane and tier tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: reissue evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The `from` id shape reissueJob itself validates before writing a row. */
const FROM_JOB_ID = /^RQ-PHX-[A-Z0-9]{3,40}$/;
/** The `to` id shape the drop writer's DROP_JOB_ID accepts. */
const TO_JOB_ID = /^[A-Z0-9]{3,40}$/;
/** The family key nextReissueId computes: the bare id minus one trailing R<n> group. */
const REISSUE_SUFFIX = /R\d+$/;

export interface JobReissueItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/job-reissues.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default JOB_REISSUE_WINDOW_MS). */
  windowMs?: number;
  /** Ledger override (default: <runsDir>/queue/job-reissues.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default JOB_REISSUE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** One validated audit row: the recorded rescue the fold needs. */
export interface JobReissueRecord {
  /** The rescued prompt id, RQ-PHX-… form. */
  from: string;
  /** The published bare id (<stem>R<n>), which lands as RQ-PHX-<to>. */
  to: string;
  /** The family stem nextReissueId derives — the grouping key. */
  stem: string;
  /** Recorded placement lane, or null when the row carried none usable. */
  lane: string | null;
  /** Recorded tier, or null when the row carried none usable. */
  tier: string | null;
  /** Row timestamp in ms. */
  atMs: number;
  /** UTC day key ('YYYY-MM-DD') the timestamp falls in. */
  utcDay: string;
}

export interface JobReissueJournalFold {
  /** Validated rows whose timestamp landed inside the window. */
  records: JobReissueRecord[];
  /** Retained-tail lines that failed JSON parse or never formed a valid row. */
  invalidRows: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text === '' ? null : text.slice(0, MAX_FIELD_CHARS);
}

/** The family a published id belongs to — the same stem nextReissueId computes. */
function reissueStem(to: string): string {
  return to.replace(REISSUE_SUFFIX, '') || to;
}

const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Validate one ledger row under the writer's contract. Returns null when
 * the row cannot name its rescue: `from` must sit inside the RQ-PHX- id
 * shape reissueJob fullmatches, `to` inside the drop writer's bare-id
 * shape, and `at` must parse — window placement is the caller's check.
 * `file` is deliberately never read: it is a local filesystem path.
 */
function parseReissueRow(row: Record<string, unknown>): Omit<JobReissueRecord, 'utcDay'> | null {
  const from = row['from'];
  const to = row['to'];
  if (typeof from !== 'string' || !FROM_JOB_ID.test(from)) return null;
  if (typeof to !== 'string' || !TO_JOB_ID.test(to)) return null;
  const at = row['at'];
  const atMs = parseLedgerTs(at);
  if (atMs === null) return null;
  return { from, to, stem: reissueStem(to), lane: fieldText(row['lane']), tier: fieldText(row['tier']), atMs };
}

/**
 * Pure: fold one audit-ledger tail into validated in-window records.
 * Rows are validated under the writer's contract; rows whose timestamp
 * cannot be placed inside [nowMs - windowMs, nowMs + skew] never reach
 * the fold. lane/tier degrade to null rather than suppressing the row —
 * they are placement context, not attribution.
 */
export function foldJobReissueJournal(text: string, nowMs: number, windowMs: number): JobReissueJournalFold {
  const fold: JobReissueJournalFold = { records: [], invalidRows: 0 };
  const since = nowMs - windowMs;
  const until = nowMs + JOB_REISSUE_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { fold.invalidRows += 1; continue; }
    const parsed = parseReissueRow(row as Record<string, unknown>);
    if (parsed === null) { fold.invalidRows += 1; continue; }
    if (parsed.atMs < since || parsed.atMs > until) continue;
    fold.records.push({ ...parsed, utcDay: dayOfMs(parsed.atMs) });
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

/** One recurring family: the same stem rescued often enough to be a pattern. */
export interface JobReissueChainCell {
  kind: 'chain';
  /** The family stem (uppercase alnum job-code text, quoted as an opaque id). */
  stem: string;
  /** Rescue rows the family recorded inside the window. */
  rows: number;
  /** Distinct UTC days the family's rescues span, sorted. */
  days: string[];
  /** Per-lane tallies of the family's rescues, most frequent first. */
  lanes: [string, number][];
  /** Per-tier tallies of the family's rescues, most frequent first. */
  tiers: [string, number][];
  /** Up to MAX_EXAMPLES published bare ids, first-seen order. */
  examples: string[];
  /** The rescued `from` ids seen, up to MAX_EXAMPLES, first-seen order. */
  sources: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

/** The breadth cell: enough distinct families rescued to read as a fleet-wide pattern. */
export interface JobReissueWaveCell {
  kind: 'wave';
  /** Distinct family stems rescued inside the window. */
  stems: number;
  /** Total rescue rows inside the window. */
  rows: number;
  /** How many of those stems also met the chain bar — repeat families inside the wave. */
  repeatStems: number;
  /** Distinct UTC days the rescues span, sorted. */
  days: string[];
  /** Per-lane tallies across every in-window rescue, most frequent first. */
  lanes: [string, number][];
  /** Per-tier tallies across every in-window rescue, most frequent first. */
  tiers: [string, number][];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export type JobReissueCell = JobReissueChainCell | JobReissueWaveCell;

function tallyOf(map: Map<string, number>, max: number): [string, number][] {
  return [...map.entries()]
    .map(([text, count]) => [text, count] as [string, number])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max);
}

interface StemAccum {
  stem: string;
  rows: number;
  days: Set<string>;
  lanes: Map<string, number>;
  tiers: Map<string, number>;
  examples: string[];
  sources: string[];
  firstMs: number;
  lastMs: number;
}

function newStemAccum(stem: string): StemAccum {
  return { stem, rows: 0, days: new Set(), lanes: new Map(), tiers: new Map(), examples: [], sources: [], firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY };
}

function absorb(acc: StemAccum, record: JobReissueRecord): void {
  acc.rows += 1;
  acc.days.add(record.utcDay);
  if (record.lane !== null) acc.lanes.set(record.lane, (acc.lanes.get(record.lane) ?? 0) + 1);
  if (record.tier !== null) acc.tiers.set(record.tier, (acc.tiers.get(record.tier) ?? 0) + 1);
  if (!acc.examples.includes(record.to) && acc.examples.length < MAX_EXAMPLES) acc.examples.push(record.to);
  if (!acc.sources.includes(record.from) && acc.sources.length < MAX_EXAMPLES) acc.sources.push(record.from);
  acc.firstMs = Math.min(acc.firstMs, record.atMs);
  acc.lastMs = Math.max(acc.lastMs, record.atMs);
}

function isoOrNull(ms: number): string | null {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Pure: the recurring cells the fold justifies. A family emits a chain
 * cell only while its rescue rows reach JOB_REISSUE_CHAIN_MIN_ROWS and
 * span JOB_REISSUE_CHAIN_MIN_DAYS distinct UTC days; the wave cell
 * emits only while the window's rescues cover JOB_REISSUE_WAVE_MIN_STEMS
 * distinct families across JOB_REISSUE_WAVE_MIN_DAYS days. Chains sort
 * by rows descending then stem; the wave sorts last. Deterministic.
 */
export function jobReissueCells(fold: JobReissueJournalFold, lowerBound = false): JobReissueCell[] {
  const stems = new Map<string, StemAccum>();
  const allDays = new Set<string>();
  const allLanes = new Map<string, number>();
  const allTiers = new Map<string, number>();
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const record of fold.records) {
    let acc = stems.get(record.stem);
    if (acc === undefined) { acc = newStemAccum(record.stem); stems.set(record.stem, acc); }
    absorb(acc, record);
    allDays.add(record.utcDay);
    if (record.lane !== null) allLanes.set(record.lane, (allLanes.get(record.lane) ?? 0) + 1);
    if (record.tier !== null) allTiers.set(record.tier, (allTiers.get(record.tier) ?? 0) + 1);
    firstMs = Math.min(firstMs, record.atMs);
    lastMs = Math.max(lastMs, record.atMs);
  }
  const chains: JobReissueChainCell[] = [];
  let repeatStems = 0;
  for (const acc of stems.values()) {
    const recurring = acc.rows >= JOB_REISSUE_CHAIN_MIN_ROWS && acc.days.size >= JOB_REISSUE_CHAIN_MIN_DAYS;
    if (recurring) repeatStems += 1;
    if (!recurring) continue;
    chains.push({
      kind: 'chain',
      stem: acc.stem,
      rows: acc.rows,
      days: [...acc.days].sort(),
      lanes: tallyOf(acc.lanes, MAX_PROMPT_TALLIES),
      tiers: tallyOf(acc.tiers, MAX_PROMPT_TALLIES),
      examples: acc.examples,
      sources: acc.sources,
      firstSeen: isoOrNull(acc.firstMs),
      lastSeen: isoOrNull(acc.lastMs),
      lowerBound,
    });
  }
  chains.sort((a, b) => b.rows - a.rows || a.stem.localeCompare(b.stem));
  const cells: JobReissueCell[] = [...chains];
  if (stems.size >= JOB_REISSUE_WAVE_MIN_STEMS && allDays.size >= JOB_REISSUE_WAVE_MIN_DAYS) {
    cells.push({
      kind: 'wave',
      stems: stems.size,
      rows: fold.records.length,
      repeatStems,
      days: [...allDays].sort(),
      lanes: tallyOf(allLanes, MAX_PROMPT_TALLIES),
      tiers: tallyOf(allTiers, MAX_PROMPT_TALLIES),
      firstSeen: isoOrNull(firstMs),
      lastSeen: isoOrNull(lastMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the rescues were deliberate one-off retries whose R-suffix generations all landed, the repeated families trace to prompts or job specs an operator already fixed, or the cause is owner-side — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only gap and the reproduction fold are named so the session can verify it. */
const EVIDENCE = 'The evidence is queue/job-reissues.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the append-only audit ledger reissueJob (src/core/fleet/job-reissue.ts) writes for POST /api/verse/outcomes/fleet-reissue and the Fleet Outcomes pane\'s Reissue button — one {at, from, to, lane, tier, file} row per successful re-drop, where `from` is the rescued RQ-PHX- prompt id, `to` the bare <stem>R<n> id published as RQ-PHX-<to> under leader/drop/<lane>/, and `file` a local prompt path this fold never reads. Until this feed the ledger had no reader at all: not the router outcome fold, not outcome learning, not any report — recurring rescues of the same job families never became work. Whether a rescue landed is recorded on the RQ-PHX-<to> generations\' own jobs.jsonl rows (launch, finish, publish, outcome) under metrics/jobs.jsonl.';

const tallyText = (tallies: readonly [string, number][]): string =>
  tallies.length === 0 ? 'none recorded' : tallies.map(([text, count]) => `'${text}' ×${count}`).join(', ');

const boundText = (lowerBound: boolean): string =>
  lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained rows — a lower bound, not the full window.' : '';

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen ? ` Recorded ${firstSeen}.` : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

function examplesText(examples: readonly string[], sources: readonly string[]): string {
  const parts: string[] = [];
  if (examples.length > 0) parts.push(`Published rescue ids: ${examples.map((id) => `RQ-PHX-${id}`).join(', ')}.`);
  if (sources.length > 0) parts.push(`Rescued prompt ids include: ${sources.join(', ')}.`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function chainPrompt(cell: JobReissueChainCell): string {
  return [
    `Phantom's job-reissue ledger keeps recording the same job family needing manual rescue — stem '${cell.stem}' was reissued ${cell.rows} time(s) across ${cell.days.length} distinct UTC day(s) inside the 7-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one recorded decision that this job's prompt deserved another run: reissueJob re-dropped it under the next <stem>R<n> id and the drop writer published it as an ordinary job. A family rescued repeatedly means the job keeps dying or being abandoned before it lands — a job spec or prompt defect, a lane that cannot carry it, or infra churn the rescues are papering over.${examplesText(cell.examples, cell.sources)}`,
    '',
    `Lanes: ${tallyText(cell.lanes)}. Tiers: ${tallyText(cell.tiers)}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the reissue verb and family naming (src/core/fleet/job-reissue.ts nextReissueId/reissueJob), the drop-job publish path (src/core/fleet/drop-job-writer.ts), the API endpoint (src/core/verse/outcomes-api.ts fleet-reissue) and the Fleet Outcomes pane button — plus whatever should consume the rescue signal: whether the RQ-PHX-<to> generations' own jobs.jsonl rows show them merging, churning or dying the same way (join on the published ids above), whether the family should be flagged earlier than a human noticing, or whether repeated rescues of one stem should feed job-spec or prompt repair work instead of silent re-drops. The audit ledger's \`file\` field is a local path and stays out of prompts by contract. If the rescues were deliberate one-off retries, the generations all landed, or the cause is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function wavePrompt(cell: JobReissueWaveCell): string {
  return [
    `Phantom's job-reissue ledger keeps recording manual rescues across the fleet — ${cell.stems} distinct job families were reissued ${cell.rows} time(s) across ${cell.days.length} distinct UTC day(s) inside the 7-day window (${cell.repeatStems} of those families needed more than one rescue), the self-improvement work this backlog exists for.`,
    '',
    `Each row is one recorded decision that a job's prompt deserved another run. Isolated rescues are routine ops; this many distinct families needing rescue inside one window reads as a systemic signal — a lane or dispatcher regression producing dead jobs, a batch of job specs that cannot land, or an outcome surface that keeps pushing work back to manual retry.`,
    '',
    `Lanes: ${tallyText(cell.lanes)}. Tiers: ${tallyText(cell.tiers)}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the same surfaces the per-family items name — the reissue verb (src/core/fleet/job-reissue.ts), the drop-job publish path (src/core/fleet/drop-job-writer.ts), the API endpoint (src/core/verse/outcomes-api.ts) and the Fleet Outcomes pane — plus the fleet's own outcome and yield machinery that should explain WHY this many jobs needed rescue: the jobs.jsonl finish/outcome rows for the rescued and R-suffix generations (\`phm jobs yield --by source\`, \`phm fleet outcomes\`, \`phm router outcomes\` fold the same ledger), the lane health and empty-finish evidence beside them, and whether rescue volume should itself become a first-class signal (e.g., a reissue-rate line in the vitals or scorecard reports) rather than an audit file only a fold reads. If the rescues were a one-off cleanup burst or all landed on retry — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function jobReissueItem(cell: JobReissueCell, repo: string): CloudBacklogItem {
  const id = cell.kind === 'chain'
    ? `fleet-job-reissue-${createHash('sha256').update(`job-reissue:chain:${cell.stem}`).digest('hex').slice(0, 16)}`
    : `fleet-job-reissue-${createHash('sha256').update('job-reissue:wave').digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'chain'
    ? `Job family ${cell.stem} keeps needing manual reissue`
    : 'Fleet jobs keep needing manual reissue rescue';
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'chain' ? chainPrompt(cell) : wavePrompt(cell),
    area: 'job-reissue',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the job-reissue ledger's recurring rescue cells.
 * Total: a missing ledger, another repository or any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function jobReissueBacklogItems(opts: JobReissueItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : JOB_REISSUE_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const path = opts.journalPath ?? join(runsDir, 'queue', 'job-reissues.jsonl');
    const tail = await readLedgerTail(path, JOB_REISSUE_TAIL_BYTES);
    // A missing ledger is a clean empty source; an unreadable or
    // non-file read means evidence exists that cannot be trusted —
    // fail closed. A truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const fold = foldJobReissueJournal(tail.text, nowMs, windowMs);
    if (fold.records.length === 0) return [];
    const cells = jobReissueCells(fold, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_REISSUE_MAX_ITEMS, JOB_REISSUE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => jobReissueItem(cell, repo));
  } catch {
    return [];
  }
}
