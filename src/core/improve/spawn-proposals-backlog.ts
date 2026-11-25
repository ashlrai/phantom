/**
 * <runs>/queue/spawn-proposals.jsonl spawn-proposal journal →
 * self-improvement backlog items.
 *
 * `phm queue spawn <spawn.json|->` (src/cli/job-queue.ts) and the
 * dispatchd-side `POST /v1/spawn` ingest (src/core/queue/ingest.ts) both
 * apply a spawn.v1 self-decomposition proposal through
 * QueueStore.propose (src/core/queue/store.ts). planSpawn
 * (src/core/queue/decompose.ts) resolves each proposed child id against
 * the queue document, the proposal's own siblings and the merged-job
 * ids loadMergedJobIds folds out of <runs>/metrics/jobs.jsonl: an id
 * already known to the fleet lands in `duplicates` instead of the
 * queue, every surviving child must pass the parent's tier, priority,
 * pool and dependency policy, and only then does the store journal one
 * {v, at, parent, owner, proposed, applied, duplicates} row — proposed
 * children in, applied queue entries plus duplicate drops out. The
 * same row feeds the per-parent rate cap: on every write the journal
 * drops entries older than SPAWN_LIMITS.windowMs (24h) and keeps the
 * newest SPAWN_LIMITS.journalEntries (4096), so the file only ever
 * retains roughly the current rate window.
 *
 * Until now the journal had no reader at all — its only consumer was
 * the rate cap's own fresh-window filter, a point-in-time enforcement
 * read. A parent that kept spending its four-proposals-a-day budget on
 * children the fleet already had queued or already landed, or a fleet
 * whose proposers systematically re-decomposed merged work, looked
 * like a string of one-off dedup catches — never a pattern, never
 * work. Agent self-decomposition IS the fleet's own
 * recursive-improvement surface, so its recurring waste is the lane's
 * most direct evidence.
 *
 * spawnProposalsBacklogItems carries the same rows into
 * discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process
 *    or network is touched. A missing or unreadable file yields no
 *    items — unknown stays unknown, never a guessed tally — while a
 *    truncated tail still folds the retained rows with the prompts
 *    stating the counts as lower bounds.
 *  - Rows count only under the store's own contract: the fold
 *    validates exactly what readSpawnJournal enforces — v === 1, a
 *    parseable bounded `at`, parent inside the queue JOB_ID grammar,
 *    owner a bounded printable label, and proposed/applied/duplicates
 *    safe integers inside the journal's 0..100 000 range. Malformed
 *    lines, foreign shapes and off-contract rows are skipped, never
 *    guessed.
 *  - Recurring means recorded inside the journal's own horizon: the
 *    writer truncates the file to the 24h rate window on every append,
 *    so the evidence unit is the retained window itself, not days — a
 *    cell emits on row and parent counts alone, and the prompts state
 *    the retention bound. A parent cell emits at
 *    SPAWN_MIN_DUP_ONLY_ROWS proposals whose every proposed child was
 *    already known (applied === 0 with duplicates > 0) — at least
 *    three quarters of the parent's four-proposal daily cap spent
 *    producing zero new queue entries. A fleet cell emits at
 *    SPAWN_MIN_FLEET_DUP_ROWS such rows across
 *    SPAWN_MIN_FLEET_PARENTS distinct parents — the systemic case no
 *    single parent repeats enough to show. Partially-duplicate
 *    proposals (applied > 0 alongside duplicates) and clean proposals
 *    still count toward the totals the prompts quote, but never toward
 *    the bars: one redundant child inside useful work is dedup doing
 *    its job, not a finding.
 *  - Every journaled row is an ACCEPTED proposal — planSpawn throws
 *    before journaling on policy rejections, so refused work never
 *    reaches this file; only accepted-but-redundant decomposition is
 *    evidence here.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's queue and carries no repository column. Dedup is
 *    downstream: the item id hashes the cell identity, never counts
 *    or timestamps, so a refresh re-derives the same id and a
 *    recovered parent simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is parents plus one fleet cell. */
export const SPAWN_PROPOSALS_BACKLOG_MAX_ITEMS = 12;
const SPAWN_PROPOSALS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention; the journal itself only retains ~24h. */
export const SPAWN_PROPOSALS_WINDOW_HOURS = 168;
/** A parent cell emits at this many all-duplicate proposals in-window — ~75% of its 4/day cap. */
export const SPAWN_MIN_DUP_ONLY_ROWS = 3;
/** The fleet cell emits at this many all-duplicate rows... */
export const SPAWN_MIN_FLEET_DUP_ROWS = 4;
/** ...spread across at least this many distinct parents, so no single parent must repeat to show. */
export const SPAWN_MIN_FLEET_PARENTS = 2;
/** Bounded no-follow tail; the writer caps the file at 4096 entries, so 1 MiB covers the whole journal. */
export const SPAWN_PROPOSALS_TAIL_BYTES = 1024 * 1024;
/** The fleet's own repository label: spawn evidence is this install's queue, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded ids/labels are bounded identifiers; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Distinct owner labels quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_OWNERS = 3;
/** The writer's parent grammar (JOB_ID) and owner grammar (LABEL, journaled as a bounded string). */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OWNER_CHARS = 128;
const MAX_COUNT = 100_000;

export interface SpawnProposalsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: join(runsDir, 'queue', 'spawn-proposals.jsonl')). */
  journalPath?: string;
  /** Runs dir for the journal default; a non-empty absolute ASHLR_RUNS_DIR wins, else ~/.ashlr-runs — the CLI's own resolution. */
  runsDir?: string;
  /** Home for the ~/.ashlr-runs fallback; default homedir(). */
  homeDir?: string;
  /** Evidence window in hours (default SPAWN_PROPOSALS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default SPAWN_PROPOSALS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** The runs dir the CLI's own resolution picks: absolute ASHLR_RUNS_DIR, else ~/.ashlr-runs. */
function defaultRunsDir(homeDir: string): string {
  const env = process.env['ASHLR_RUNS_DIR'];
  if (env !== undefined && env !== '' && isAbsolute(env)) return env;
  return join(homeDir, '.ashlr-runs');
}

// ---------------------------------------------------------------------------
// Row contract — one SpawnJournalEntry exactly as QueueStore.propose appends it
// ---------------------------------------------------------------------------

interface SpawnProposalRow {
  atMs: number;
  parent: string;
  owner: string;
  proposed: number;
  applied: number;
  duplicates: number;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function countField(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

/**
 * Structural validation of one persisted row against the contract
 * readSpawnJournal enforces (isSpawnJournalEntry in
 * src/core/queue/store.ts): v === 1, a bounded parseable `at`, parent
 * inside the JOB_ID grammar, owner a bounded printable label, and the
 * three counts safe integers inside the journal's range. Returns null
 * for a corrupted or foreign row so the caller counts it malformed and
 * skips it rather than let damaged evidence masquerade as a real
 * proposal. `at` is bounded tighter than the file contract requires —
 * the writer only ever emits toISOString() instants (~24 chars).
 */
function projectSpawnRow(row: Record<string, unknown>): SpawnProposalRow | null {
  if (row['v'] !== 1) return null;
  const at = row['at'];
  if (!boundedString(at, 64)) return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const parent = row['parent'];
  if (typeof parent !== 'string' || !JOB_ID.test(parent)) return null;
  const owner = row['owner'];
  if (!boundedString(owner, MAX_OWNER_CHARS)) return null;
  const proposed = row['proposed'];
  const applied = row['applied'];
  const duplicates = row['duplicates'];
  if (!countField(proposed) || !countField(applied) || !countField(duplicates)) return null;
  return { atMs, parent, owner, proposed, applied, duplicates };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-parent in-window fold before the recurring bars apply. */
export interface SpawnParentFold {
  parent: string;
  /** Distinct claim-holder labels seen on this parent's rows. */
  owners: Set<string>;
  /** In-window rows for this parent. */
  rows: number;
  /** Rows where every proposed child was already known: applied === 0 with duplicates > 0. */
  dupOnly: number;
  /** Rows carrying any duplicate drop (dupOnly plus partial-duplicate proposals). */
  dupRows: number;
  proposedTotal: number;
  appliedTotal: number;
  duplicatesTotal: number;
  /** Distinct UTC days. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface SpawnProposalsFold {
  /** In-window parsed proposal rows — the share denominator the prompts quote. */
  proposals: number;
  parents: Map<string, SpawnParentFold>;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
  /** Parsed rows outside the window or beyond the future-skew tolerance. */
  outsideWindow: number;
}

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

/**
 * Pure: fold journal text(s) — oldest first — into per-parent recurring
 * proposal evidence. Lines that fail the writer's row contract, and
 * rows outside the window, are skipped, never guessed.
 */
export function foldSpawnProposals(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): SpawnProposalsFold {
  const fold: SpawnProposalsFold = { proposals: 0, parents: new Map(), malformed: 0, outsideWindow: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fold.malformed++;
        continue;
      }
      const row = projectSpawnRow(parsed as Record<string, unknown>);
      if (row === null) { fold.malformed++; continue; }
      if (row.atMs < since || row.atMs > until) { fold.outsideWindow++; continue; }
      fold.proposals += 1;
      let cell = fold.parents.get(row.parent);
      if (cell === undefined) {
        cell = { parent: row.parent, owners: new Set(), rows: 0, dupOnly: 0, dupRows: 0,
          proposedTotal: 0, appliedTotal: 0, duplicatesTotal: 0, days: new Set(), firstMs: null, lastMs: null };
        fold.parents.set(row.parent, cell);
      }
      cell.rows += 1;
      cell.owners.add(row.owner);
      if (row.duplicates > 0) cell.dupRows += 1;
      if (row.applied === 0 && row.duplicates > 0) cell.dupOnly += 1;
      cell.proposedTotal += row.proposed;
      cell.appliedTotal += row.applied;
      cell.duplicatesTotal += row.duplicates;
      cell.days.add(dayOf(row.atMs));
      touch(cell, row.atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface SpawnProposalCell {
  kind: 'spawn-duplicates' | 'spawn-duplicates-fleet';
  /** The recurring parent; null on the fleet-wide cell. */
  parent: string | null;
  /** In-window parsed proposal rows in this cell's scope — the share denominator. */
  proposals: number;
  /** Rows where every proposed child was already known. */
  dupOnly: number;
  /** Rows carrying any duplicate drop. */
  dupRows: number;
  /** Summed proposed/applied/duplicates counts across the cell's rows. */
  proposedTotal: number;
  appliedTotal: number;
  duplicatesTotal: number;
  /** Distinct parents in scope (the fleet cell's spread evidence). */
  parents: number;
  /** True distinct claim-holder count across the cell's rows. */
  ownerTotal: number;
  /** Sorted distinct claim-holder labels, capped for the prompt. */
  owners: string[];
  /** Sorted distinct UTC days. */
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

const toCell = (
  kind: SpawnProposalCell['kind'],
  parent: string | null,
  scope: readonly SpawnParentFold[],
  proposals: number,
  lowerBound: boolean,
): SpawnProposalCell => {
  const days = new Set<string>();
  const owners = new Set<string>();
  const totals = { proposedTotal: 0, appliedTotal: 0, duplicatesTotal: 0, dupOnly: 0, dupRows: 0 };
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const cell of scope) {
    totals.proposedTotal += cell.proposedTotal;
    totals.appliedTotal += cell.appliedTotal;
    totals.duplicatesTotal += cell.duplicatesTotal;
    totals.dupOnly += cell.dupOnly;
    totals.dupRows += cell.dupRows;
    for (const day of cell.days) days.add(day);
    for (const owner of cell.owners) owners.add(owner);
    if (cell.firstMs !== null) firstMs = firstMs === null ? cell.firstMs : Math.min(firstMs, cell.firstMs);
    if (cell.lastMs !== null) lastMs = lastMs === null ? cell.lastMs : Math.max(lastMs, cell.lastMs);
  }
  return {
    kind,
    parent,
    proposals,
    dupOnly: totals.dupOnly,
    dupRows: totals.dupRows,
    proposedTotal: totals.proposedTotal,
    appliedTotal: totals.appliedTotal,
    duplicatesTotal: totals.duplicatesTotal,
    parents: scope.length,
    ownerTotal: owners.size,
    owners: [...owners].sort().slice(0, MAX_PROMPT_OWNERS),
    days: [...days].sort(),
    firstSeen: isoOrNull(firstMs),
    lastSeen: isoOrNull(lastMs),
    lowerBound,
  };
};

/**
 * Pure: recurring cells — one per parent at the all-duplicate bar, plus
 * the fleet-wide cell when enough parents repeat the pattern. The
 * journal's own 24h retention means there is no day bar to clear: the
 * retained window IS the recurrence horizon, and the bars are sized
 * against the writer's four-proposals-per-parent-per-day cap.
 */
export function spawnProposalCells(fold: SpawnProposalsFold, lowerBound = false): SpawnProposalCell[] {
  const cells: SpawnProposalCell[] = [];
  for (const cell of fold.parents.values()) {
    if (cell.dupOnly >= SPAWN_MIN_DUP_ONLY_ROWS) {
      cells.push(toCell('spawn-duplicates', cell.parent, [cell], fold.proposals, lowerBound));
    }
  }
  const fleetDupOnly = [...fold.parents.values()].reduce((sum, cell) => sum + cell.dupOnly, 0);
  const dupParents = [...fold.parents.values()].filter((cell) => cell.dupOnly > 0);
  if (fleetDupOnly >= SPAWN_MIN_FLEET_DUP_ROWS && dupParents.length >= SPAWN_MIN_FLEET_PARENTS) {
    cells.unshift(toCell('spawn-duplicates-fleet', null, dupParents, fold.proposals, lowerBound));
  }
  return cells.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'spawn-duplicates-fleet' ? -1 : 1;
    return b.dupOnly - a.dupOnly || (a.parent ?? '').localeCompare(b.parent ?? '');
  });
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/queue/spawn-proposals.jsonl — QueueStore.spawnJournalPath in src/core/queue/store.ts resolves <runs>/queue (an absolute ASHLR_RUNS_DIR wins, else ~/.ashlr-runs) — one {v, at, parent, owner, proposed, applied, duplicates} row per ACCEPTED spawn.v1 self-decomposition proposal, journaled by QueueStore.propose after planSpawn (src/core/queue/decompose.ts) resolves child ids against the queue document, proposal siblings and the merged-job ids folded from <runs>/metrics/jobs.jsonl. The writer truncates the file to the 24-hour rate window and 4096 entries on every append, so the journal only ever retains roughly the current window. Until now the journal had no reader at all: its only consumer was the rate cap\'s own fresh-window filter, so a parent spending its four-proposals-a-day budget on children the fleet already had queued or already landed never became work.';

const REPRO = 'Reproduce the fold by reading <runs dir>/queue/spawn-proposals.jsonl directly, keeping rows whose at lands inside the window, grouping by parent, and counting rows where applied is 0 while duplicates is positive — every proposed child was already known to the fleet. The writer, dedup and rate cap this repository owns are QueueStore.propose/readSpawnJournal in src/core/queue/store.ts, planSpawn/parseSpawn/SPAWN_LIMITS in src/core/queue/decompose.ts, the `phm queue spawn` entry in src/cli/job-queue.ts and the POST /v1/spawn ingest in src/core/queue/ingest.ts.';

const NO_CHANGE = 'If spawn proposals only run during concentrated decomposition campaigns the journal is a sparse sample rather than a continuous record; if the duplicated ids were intentionally re-proposed to re-base stale children onto fresh deps, the dedup is absorbing deliberate refreshes; if the proposing agent had no cheaper way to check the queue and merged ledger before decomposing, the waste is the missing pre-flight, not the dedup itself; or if the duplicates were sibling collisions inside single proposals the planner already handles — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const ownersText = (cell: SpawnProposalCell): string => {
  if (cell.ownerTotal === 0) return '';
  const shown = cell.owners.map((owner) => fieldText(owner, MAX_NAME_CHARS)).join("', '");
  const extra = cell.ownerTotal - cell.owners.length;
  return extra > 0
    ? ` Claim holder(s) include '${shown}' (+${extra} more).`
    : ` Claim holder(s): '${shown}'.`;
};

const seenText = (cell: SpawnProposalCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: SpawnProposalCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: SpawnProposalCell): string =>
  cell.proposals > 0 ? ` (${Math.round((cell.dupOnly / cell.proposals) * 100)}% of the ${cell.proposals} in-window proposal rows)` : '';

function spawnProposalPrompt(cell: SpawnProposalCell): string {
  const headline = cell.kind === 'spawn-duplicates-fleet'
    ? `Phantom's spawn-proposal journal keeps recording all-duplicate decomposition across ${cell.parents} parents`
    : `Phantom's spawn-proposal journal keeps recording '${cell.parent}' decomposing into already-known work`;
  const claim = cell.kind === 'spawn-duplicates-fleet'
    ? 'every proposed child id was already in the queue, already merged, or duplicated inside the proposal itself — accepted proposals that produced zero new queue entries'
    : 'every proposed child id was already in the queue, already merged, or duplicated inside the proposal itself — accepted proposals that produced zero new queue entries, while the parent\'s four-per-day rate cap keeps absorbing the attempts';
  const detail = [
    headline,
    '',
    `${cell.dupOnly} all-duplicate proposal row(s)${cell.kind === 'spawn-duplicates-fleet' ? ` across ${cell.parents} distinct parent(s)` : ` for '${cell.parent}'`} out of ${cell.proposals} in-window proposal row(s) — the self-improvement work this backlog exists for.`,
    '',
    `Across the cell's rows the journal recorded ${cell.proposedTotal} proposed child(ren), ${cell.appliedTotal} applied and ${cell.duplicatesTotal} duplicate drops; ${cell.dupRows} row(s) carried at least one duplicate.${cell.kind === 'spawn-duplicates-fleet' ? '' : ` The parent can consume at most four proposals per 24-hour window (SPAWN_LIMITS.proposalsPerWindow), so ${cell.dupOnly} all-duplicate rows is most of its daily decomposition budget spent on work the fleet already had.`}${ownersText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    `Each row is one ACCEPTED spawn.v1 proposal: ${claim}.${shareText(cell)}`,
    '',
    `Recorded across ${cell.days.length} UTC day(s) (${daysText(cell.days)}). The journal self-truncates to the 24-hour rate window on every append, so these counts cover the retained window only.`,
    '',
    EVIDENCE,
    '',
    cell.kind === 'spawn-duplicates-fleet'
      ? `Find why decomposition keeps proposing work the fleet already has: check whether the agents authoring spawn.v1 proposals consult the queue document and the merged-job evidence before decomposing (the same inputs planSpawn dedups against), whether swarm or planner prompts name concrete child ids that collide with queued or landed work, whether the mergedIds feed (loadMergedJobIds over <runs>/metrics/jobs.jsonl) is stale or missing on the proposing side, and whether the dedup should reject earlier with a clearer signal to the proposer instead of silently absorbing the proposal into the rate cap. Fix what lives here — the proposal guidance, the pre-flight evidence path, or the dedup feedback loop in src/core/queue/decompose.ts and src/core/queue/store.ts.`
      : `Find why '${cell.parent}' keeps decomposing into already-known work: compare the journaled parent, owner and counts against the queue document and <runs>/metrics/jobs.jsonl to see whether the duplicates were queued children, merged outcomes or intra-proposal sibling collisions; then check whether the agent holding the claim re-proposes the same decomposition after dedup absorbs it, whether its task prompt lacks the queue/merged pre-flight, or whether the dedup is rejecting work that genuinely should re-enter under fresh ids — name which and fix what lives here: the proposing guidance, the dedup feedback in src/core/queue/decompose.ts, or the rate-cap accounting in src/core/queue/store.ts.`,
    '',
    NO_CHANGE,
    '',
    REPRO,
  ];
  return detail.join('\n');
}

function spawnProposalTitle(cell: SpawnProposalCell): string {
  return cell.kind === 'spawn-duplicates-fleet'
    ? `Spawn proposals keep duplicating already-known work fleet-wide`.slice(0, MAX_TITLE_CHARS)
    : `Job '${fieldText(cell.parent ?? '', MAX_NAME_CHARS)}' keeps proposing already-known children`.slice(0, MAX_TITLE_CHARS);
}

function spawnProposalArea(cell: SpawnProposalCell): string {
  return cell.kind === 'spawn-duplicates-fleet' ? 'spawn-duplicates-fleet' : 'spawn-duplicates';
}

function spawnProposalItem(cell: SpawnProposalCell, repo: string): CloudBacklogItem {
  const idSeed = cell.kind === 'spawn-duplicates-fleet' ? 'fleet' : `parent|${cell.parent ?? ''}`;
  return {
    id: `spawn-dup-${sha(idSeed)}`,
    title: spawnProposalTitle(cell),
    prompt: spawnProposalPrompt(cell),
    area: spawnProposalArea(cell),
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the spawn-proposal journal's recurring evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function spawnProposalsBacklogItems(opts: SpawnProposalsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? SPAWN_PROPOSALS_WINDOW_HOURS;
    const homeDir = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? defaultRunsDir(homeDir);
    const journalPath = opts.journalPath ?? join(runsDir, 'queue', 'spawn-proposals.jsonl');
    const read = await readLedgerTail(journalPath, SPAWN_PROPOSALS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so the tail folds whole.
    const fold = foldSpawnProposals([read.text], nowMs, windowHours);
    if (fold.proposals === 0) return [];
    const cells = spawnProposalCells(fold, read.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? SPAWN_PROPOSALS_BACKLOG_MAX_ITEMS, SPAWN_PROPOSALS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => spawnProposalItem(cell, repo));
  } catch {
    return [];
  }
}
