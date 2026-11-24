/**
 * Repair-handoff journal recurring evidence → self-improvement backlog
 * items.
 *
 * Every dispatch production event the daemon tick folds goes through
 * repairHandoffFromDispatchEvent
 * (src/core/fleet/repair-handoff-journal.ts): a parent proposal that
 * finished 'empty-diff' (with the diagnostic-no-proposal learning label
 * or none), 'proposal-capture-error', or 'gate-blocked' with
 * capture/completeness signals mints a repair child — a 'no-diff-reslice'
 * for empty diffs, a 'capture-repair' for the other two — and
 * recordRepairHandoffs appends one observation per minted handoff:
 *
 *   {schemaVersion, eventId, generationId, childItemId, ts, kind, repo,
 *    parentItemId, parentOutcome, parentAttemptId, parentRunId?,
 *    parentTrajectoryId?, parentSource?, parentBackend?, parentTier?,
 *    parentObjectiveHash?, diffFiles?, diffLines?, repairTreatment?,
 *    writerActivationId?, writerActivatedAt?}
 *
 * schemaVersion 1 rows append to ~/.ashlr/fleet/repair-handoffs.jsonl,
 * schemaVersion 2 rows to ~/.ashlr/fleet/repair-handoffs-v2.jsonl — the
 * writer resolves the account home (homedir()/.ashlr/fleet), never
 * $ASHLR_HOME, so a child process cannot redirect the journals. Both are
 * append-only, deduplicated by eventId under the writer's authority
 * machinery, compacted by compactRepairHandoffs, and read back by
 * readRepairHandoffs for the fleet status repair summary, the
 * generated-repair lifecycle fold and proposal-repair work admission —
 * lifecycle and status surfaces that answer "is this handoff still
 * live", never "is this failure class recurring".
 *
 * Until now the journals had no trend reader at all: a backend whose
 * parents keep finishing empty-diff, a capture path that keeps erroring,
 * or a gate that keeps blocking proposals into repair children looked
 * like isolated rows in a lifecycle ledger, never a pattern, never
 * work. Every row is already adverse evidence — the writer only records
 * a handoff when the parent failed — so recurrence is the only question
 * the fold asks.
 *
 * repairHandoffBacklogItems carries the journals into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue them
 * exactly like the sibling fleet-evidence feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Each journal file is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no lock, process or
 *    network is touched. A missing file is the writer's normal first-run
 *    state; an unreadable one yields no rows while the other still
 *    folds — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: schemaVersion 1 or 2
 *    with sha256 eventId/generationId and a bounded childItemId, a
 *    parseable ts, the closed kind/outcome vocabularies with their
 *    pairing (no-diff-reslice ⟺ empty-diff, capture-repair ⟺ the other
 *    two outcomes), the canonical absolute repo identity
 *    canonicalDispatchRepoIdentity enforces, bounded parentItemId and
 *    parentAttemptId identities, well-formed optional run/trajectory
 *    and diff-count fields (schemaVersion 2 rows must agree on the
 *    trajectory-or-run attempt identity), reslice-only repair-treatment
 *    metadata in the writer's vocabularies (required on v2 reslices),
 *    and the provenance trio
 *    (parentSource, parentBackend, parentTier) present all-or-none —
 *    required together with parentObjectiveHash on schemaVersion 2
 *    rows — with the writer's vocabularies; backend and tier may be
 *    null (unreported), source may not. Malformed lines and
 *    off-contract rows are counted, never guessed. The semantic hash
 *    derivations (eventId, generationId, childItemId recomputation)
 *    stay the canonical reader's job — this fold refuses rows that
 *    are not on-contract records, it does not re-verify digests.
 *  - Recurring means distinct and across days: a (repo, outcome,
 *    backend) cell emits only when its in-window rows name at least
 *    REPAIR_HANDOFF_MIN_UNITS distinct parentItemIds across at least
 *    REPAIR_HANDOFF_MIN_DAYS distinct UTC days inside the 7-day window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply.
 *    One failed item is a bad task, a one-day burst is a session someone
 *    closed; recurrence across days is a producer or gate that keeps
 *    feeding the repair path.
 *  - Repo attribution is by checkout basename. The journal's repo field
 *    is the canonical absolute path of the enrolled checkout (the
 *    dispatch production ledger's identity rule), not owner/name; the
 *    fold takes its last path segment, lowercased, and emits a cell only
 *    when it equals the discovery target's repository name — the same
 *    last-segment rule the sibling feeds apply. A checkout enrolled
 *    under a directory not named for its repository is conservatively
 *    unmatched: the feed emits nothing rather than misattribute another
 *    project's repair evidence, and a full path is never quoted (it
 *    would carry the account's home directory into a prompt).
 *  - The machinery is this repository's: the journal, its eligibility
 *    fold, the repair treatments and the lifecycle readers all live
 *    under src/core/fleet, while dispatchd, launch.sh, publish.sh and
 *    install-gate.py are pinned ops machinery. Items therefore emit per
 *    recorded repo and their prompts direct sessions to fix what this
 *    repository owns — the proposal pipeline, the repair treatments,
 *    the gate thresholds — or report no-change naming pinned or
 *    owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (repo
 *    name + outcome + backend — never the counts or timestamps), so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, parent item ids must match the writer's bounded
 *    identity shape before they are quoted, every journal string is
 *    scrubbed, flattened and capped before it reaches a prompt, and the
 *    brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { isSafeExecutionIdentity } from '../fleet/attempt-identity.js';
import { canonicalDispatchRepoIdentity } from '../fleet/dispatch-production-ledger.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (repo, outcome, backend) cells are bounded by vocabulary size. */
export const REPAIR_HANDOFF_BACKLOG_MAX_ITEMS = 8;
const REPAIR_HANDOFF_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const REPAIR_HANDOFF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const REPAIR_HANDOFF_FUTURE_SKEW_MS = 60_000;
/** Distinct parent work items a cell needs inside the window before its recurrence counts. */
export const REPAIR_HANDOFF_MIN_UNITS = 3;
/** Distinct UTC days those items must span — recurring means recorded across days. */
export const REPAIR_HANDOFF_MIN_DAYS = 2;
/**
 * Bounded tail per journal file. Rows run ~0.7-2 KB (the writer's own
 * MAX_ROW_BYTES is 2,048) and repair handoffs are sparse — a week of
 * fleet failures fits comfortably; a contract-violating larger file
 * still folds its newest rows with lower-bound counts.
 */
export const REPAIR_HANDOFF_TAIL_BYTES = 4 * 1024 * 1024;
/** Journal file names the writer produces under <home>/.ashlr/fleet/. */
const V1_FILE = 'repair-handoffs.jsonl';
const V2_FILE = 'repair-handoffs-v2.jsonl';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The writer's safeItemId bound: 1-180 chars, no control characters. */
const MAX_ITEM_ID_CHARS = 180;
/** Example parent item ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct tier/source tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;

export interface RepairHandoffItemsOptions {
  /** Backlog target in owner/name form; cells emit only when the row's repo basename matches its name. */
  repo: string;
  /** Fleet journal directory override (default: <home>/.ashlr/fleet — the writer's own resolution). */
  fleetDir?: string;
  /** Home for the journal default; os.homedir() when unset. */
  homeDir?: string;
  /** Most items one call emits (default REPAIR_HANDOFF_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default REPAIR_HANDOFF_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The parent outcomes the writer's eligibility fold records; kind is their deterministic partition. */
export type RepairHandoffOutcome = 'proposal-capture-error' | 'gate-blocked' | 'empty-diff';
export type RepairHandoffKind = 'capture-repair' | 'no-diff-reslice';

/** One validated handoff observation inside the evidence window. */
export interface RepairHandoffRow {
  atMs: number;
  utcDay: string;
  kind: RepairHandoffKind;
  /** Last path segment of the row's canonical repo path, lowercased — never the full path. */
  repoName: string;
  parentItemId: string;
  parentOutcome: RepairHandoffOutcome;
  /** Recorded parent backend, or null when the row carries no provenance (or reports none). */
  backend: string | null;
  /** Recorded parent tier, or null on the same terms. */
  tier: string | null;
  /** Recorded parent work source, or null on the same terms. */
  source: string | null;
  schemaVersion: 1 | 2;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The writer's validIdentity: a safe execution identity, optionally 'run:'-prefixed. */
function validIdentity(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const candidate = value.startsWith('run:') ? value.slice(4) : value;
  return isSafeExecutionIdentity(candidate);
}

/** The writer's safeItemId: 1-180 chars with no control characters. */
function safeItemId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ITEM_ID_CHARS) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** The writer's journal vocabularies (repair-handoff-journal.ts's own closed sets, not the wider type unions). */
const REPAIR_KINDS = new Set<RepairHandoffKind>(['capture-repair', 'no-diff-reslice']);
const REPAIR_OUTCOMES = new Set<RepairHandoffOutcome>(['proposal-capture-error', 'gate-blocked', 'empty-diff']);
const REPAIR_BACKENDS = new Set([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'meta-muse', 'grok',
]);
const REPAIR_TIERS = new Set(['local', 'mid', 'frontier']);
const REPAIR_SOURCES = new Set([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const REPAIR_TREATMENTS = new Set(['baseline-reslice', 'target-localization']);
const SHA256_RE = /^[a-f0-9]{64}$/;

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** The repo path's last segment — the checkout's directory name, lowercased for matching. */
function repoNameOfPath(repo: string): string {
  const trimmed = repo.replace(/[\\/]+$/, '');
  const segment = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  return segment.trim().toLowerCase();
}

/**
 * Pure: validate one parsed journal line against the writer's record
 * contract — the fields the fold reads plus the identity, provenance
 * and version-dependent requirements validObservation enforces. The
 * semantic derivations (eventId, generationId, childItemId hashes)
 * stay the canonical reader's job; this fold only refuses rows that
 * are not on-contract records at all. Anything else is not a handoff
 * row.
 */
export function parseRepairHandoffEntry(value: unknown): RepairHandoffRow | null {
  if (!isRecord(value)) return null;
  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== 2) return null;
  if (typeof value['eventId'] !== 'string' || !SHA256_RE.test(value['eventId'])) return null;
  if (typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId'])) return null;
  if (!safeItemId(value['childItemId'])) return null;
  const ts = value['ts'];
  const atMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !REPAIR_KINDS.has(kind as RepairHandoffKind)) return null;
  const parentOutcome = value['parentOutcome'];
  if (typeof parentOutcome !== 'string' || !REPAIR_OUTCOMES.has(parentOutcome as RepairHandoffOutcome)) return null;
  // The writer's own pairing: reslice is exactly the empty-diff class.
  if ((kind === 'no-diff-reslice') !== (parentOutcome === 'empty-diff')) return null;
  const repo = value['repo'];
  // The writer requires the canonical absolute checkout identity —
  // the same check validObservation applies — so a relative or
  // non-canonical path is not a handoff row.
  const canonicalRepo = canonicalDispatchRepoIdentity(repo);
  if (canonicalRepo === null || repo !== canonicalRepo) return null;
  const repoName = repoNameOfPath(canonicalRepo);
  if (repoName === '') return null;
  const parentItemId = value['parentItemId'];
  if (!safeItemId(parentItemId)) return null;
  const parentAttemptId = value['parentAttemptId'];
  if (typeof parentAttemptId !== 'string' || !validIdentity(parentAttemptId)) return null;
  for (const key of ['parentRunId', 'parentTrajectoryId'] as const) {
    const field = value[key];
    if (field !== undefined && (typeof field !== 'string' || !validIdentity(field))) return null;
  }
  for (const key of ['diffFiles', 'diffLines'] as const) {
    const field = value[key];
    if (field !== undefined && (!Number.isInteger(field) || (field as number) < 0 || (field as number) > 1_000_000)) return null;
  }
  // Repair-treatment metadata is legal only on reslice rows, with the
  // writer's unit-id and treatment vocabularies — and schemaVersion 2
  // reslice rows must carry it.
  const treatmentPresent = value['repairTreatmentUnitId'] !== undefined || value['repairTreatment'] !== undefined;
  if (treatmentPresent && (
    kind !== 'no-diff-reslice' ||
    typeof value['repairTreatmentUnitId'] !== 'string' || !SHA256_RE.test(value['repairTreatmentUnitId']) ||
    typeof value['repairTreatment'] !== 'string' || !REPAIR_TREATMENTS.has(value['repairTreatment'])
  )) return null;
  if (schemaVersion === 2 && kind === 'no-diff-reslice' && !treatmentPresent) return null;
  // The provenance trio is all-or-none under the writer's contract;
  // backend and tier may be null (unreported), source may not.
  const provenanceKeys = ['parentSource', 'parentBackend', 'parentTier'] as const;
  const present = provenanceKeys.filter((key) => value[key] !== undefined);
  if (present.length !== 0 && present.length !== provenanceKeys.length) return null;
  const objectiveHash = value['parentObjectiveHash'];
  if (objectiveHash !== undefined && (typeof objectiveHash !== 'string' || !SHA256_RE.test(objectiveHash))) return null;
  // An objective hash without full provenance is off-contract, and
  // schemaVersion 2 rows must carry both.
  if (objectiveHash !== undefined && present.length !== provenanceKeys.length) return null;
  if (schemaVersion === 2 && (typeof objectiveHash !== 'string' || present.length !== provenanceKeys.length)) return null;
  if (schemaVersion === 2) {
    // The writer's v2 attempt rule: run/trajectory ids, when both are
    // present, must agree, and parentAttemptId must be the
    // trajectory-or-run identity — a v2 row without either is
    // off-contract.
    const runId = value['parentRunId'];
    const trajectoryId = value['parentTrajectoryId'];
    if (runId !== undefined && trajectoryId !== undefined && trajectoryId !== `run:${String(runId)}`) return null;
    const authoritative = trajectoryId ?? runId;
    if (typeof authoritative !== 'string' || parentAttemptId !== authoritative) return null;
  }
  let backend: string | null = null;
  let tier: string | null = null;
  let source: string | null = null;
  if (present.length === provenanceKeys.length) {
    const rawSource = value['parentSource'];
    const rawBackend = value['parentBackend'];
    const rawTier = value['parentTier'];
    if (typeof rawSource !== 'string' || !REPAIR_SOURCES.has(rawSource)) return null;
    if (!(rawBackend === null || (typeof rawBackend === 'string' && REPAIR_BACKENDS.has(rawBackend)))) return null;
    if (!(rawTier === null || (typeof rawTier === 'string' && REPAIR_TIERS.has(rawTier)))) return null;
    source = rawSource;
    backend = rawBackend;
    tier = rawTier;
  }
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    kind: kind as RepairHandoffKind,
    repoName,
    parentItemId,
    parentOutcome: parentOutcome as RepairHandoffOutcome,
    backend,
    tier,
    source,
    schemaVersion,
  };
}

/**
 * Pure: parse one journal file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseRepairHandoffLedger(text: string): { rows: RepairHandoffRow[]; invalidRows: number } {
  const rows: RepairHandoffRow[] = [];
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
    const row = parseRepairHandoffEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

export interface RepairHandoffTally {
  /** Sanitized recorded text (a tier or source label). */
  text: string;
  count: number;
}

/** One (repo, outcome, backend) cell: distinct parents needing repair plus the recorded detail the prompt quotes. */
export interface RepairHandoffCell {
  repoName: string;
  parentOutcome: RepairHandoffOutcome;
  /** Recorded backend label, or 'unrecorded' when the rows carry no backend provenance. */
  backend: string;
  /** The writer's repair kind for this outcome class ('no-diff-reslice' for empty-diff, else 'capture-repair'). */
  kind: RepairHandoffKind;
  /** Distinct parentItemIds the journal recorded inside the window. */
  units: number;
  /** In-window handoff rows in the cell (a parent can hand off more than once across retries). */
  rows: number;
  /** Distinct UTC days the rows fall on. */
  days: Set<string>;
  /** Recorded parent tiers, most frequent first (capped at MAX_PROMPT_TALLIES). */
  tiers: RepairHandoffTally[];
  /** Recorded parent sources, most frequent first (capped at MAX_PROMPT_TALLIES). */
  sources: RepairHandoffTally[];
  /** Up to MAX_EXAMPLES parent item ids. */
  examples: string[];
  /** ISO bounds of the cell's recorded handoffs; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): RepairHandoffTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + REPAIR_HANDOFF_FUTURE_SKEW_MS;

/**
 * Pure: fold validated rows into per-(repo, outcome, backend) cells.
 * Rows outside the window and rows whose checkout basename is not
 * opts.repoName never join a cell. Backend labels group under
 * 'unrecorded' when the row carries no provenance — the evidence
 * still counts, the producer detail is just unknown.
 */
export function foldRepairHandoffCells(
  rows: readonly RepairHandoffRow[],
  opts: { nowMs: number; windowMs?: number; repoName: string },
  lowerBound = false,
): RepairHandoffCell[] {
  const windowMs = opts.windowMs ?? REPAIR_HANDOFF_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, {
    repoName: string;
    parentOutcome: RepairHandoffOutcome;
    backend: string;
    items: Set<string>;
    rows: number;
    days: Set<string>;
    tiers: Map<string, number>;
    sources: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const row of rows) {
    if (row.repoName !== opts.repoName) continue;
    if (!inWindow(row.atMs, windowStart, opts.nowMs)) continue;
    const backend = row.backend === null ? 'unrecorded' : fieldText(row.backend, 60) || 'unrecorded';
    const key = JSON.stringify([row.repoName, row.parentOutcome, backend]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        repoName: row.repoName,
        parentOutcome: row.parentOutcome,
        backend,
        items: new Set(),
        rows: 0,
        days: new Set(),
        tiers: new Map(),
        sources: new Map(),
        firstMs: null,
        lastMs: null,
      };
      cells.set(key, cell);
    }
    cell.items.add(row.parentItemId);
    cell.rows += 1;
    cell.days.add(row.utcDay);
    if (row.tier !== null) bump(cell.tiers, fieldText(row.tier, 20) || 'unrecorded');
    if (row.source !== null) bump(cell.sources, fieldText(row.source, 20) || 'unrecorded');
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      repoName: cell.repoName,
      parentOutcome: cell.parentOutcome,
      backend: cell.backend,
      kind: cell.parentOutcome === 'empty-diff' ? 'no-diff-reslice' as const : 'capture-repair' as const,
      units: cell.items.size,
      rows: cell.rows,
      days: cell.days,
      tiers: tallyOf(cell.tiers, MAX_PROMPT_TALLIES),
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      examples: [...cell.items].slice(0, MAX_EXAMPLES).map((id) => fieldText(id, 120)),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.units - a.units || b.rows - a.rows || a.backend.localeCompare(b.backend) || a.parentOutcome.localeCompare(b.parentOutcome));
}

/** The evidence pointers every prompt shares; the write-only-journal gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/fleet/repair-handoffs.jsonl and ~/.ashlr/fleet/repair-handoffs-v2.jsonl under the account home — the writer resolves homedir()/.ashlr/fleet, never $ASHLR_HOME, so a child process cannot redirect it (repairHandoffJournalPath and repairHandoffV2JournalPath in src/core/fleet/repair-handoff-journal.ts). recordRepairHandoffs appends one observation per repair handoff the daemon tick mints: repairHandoffFromDispatchEvent decides eligibility from each dispatch production event (basis \'run-proposal-outcome\', proposalCreated false, outcome \'empty-diff\' with the diagnostic-no-proposal learning label or none, \'proposal-capture-error\', or \'gate-blocked\' with capture/completeness signals), the daemon loop in src/core/daemon/loop.ts calls it on every production event while foundry.proposalRepair stays enabled, schemaVersion 1 rows land in repair-handoffs.jsonl and schemaVersion 2 rows in repair-handoffs-v2.jsonl, and both files are append-only, deduplicated by eventId under the writer\'s authority machinery and compacted by compactRepairHandoffs. readRepairHandoffs feeds the fleet status repair summary, the generated-repair lifecycle fold and proposal-repair work admission — lifecycle and status surfaces answering "is this handoff still live", never a recurrence fold. Until this feed the journals had no trend reader at all.';

const NO_CHANGE = 'If the window has rolled forward, the rows were a one-off burst the repair children already resolved, the failures were legitimate holds on work that is genuinely unworkable, or the cause is owner-side or pinned ops machinery (credentials, billing, host resources, the installed schedules, the Security-reviewed files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

function tallyText(tallies: readonly RepairHandoffTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: RepairHandoffCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function tierText(cell: RepairHandoffCell): string {
  return cell.tiers.length === 0 ? '' : ` Recorded parent tiers: ${tallyText(cell.tiers)}.`;
}

function sourceText(cell: RepairHandoffCell): string {
  return cell.sources.length === 0 ? '' : ` Recorded parent sources: ${tallyText(cell.sources)}.`;
}

function examplesText(cell: RepairHandoffCell): string {
  return cell.examples.length === 0 ? '' : ` Example parent item ids: ${cell.examples.join(', ')}.`;
}

function boundText(cell: RepairHandoffCell): string {
  return cell.lowerBound ? ' A bounded journal tail was truncated, so these counts are a lower bound.' : '';
}

/** File-level read tallies every prompt states alongside the per-cell bound note. */
interface Coverage {
  invalidRows: number;
  unreadableFiles: number;
}

function coverageNote(coverage: Coverage): string {
  const notes: string[] = [];
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract lines dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} journal file(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function backendLabel(cell: RepairHandoffCell): string {
  return cell.backend === 'unrecorded' ? 'an unrecorded backend' : `backend '${cell.backend}'`;
}

function emptyDiffPrompt(cell: RepairHandoffCell, coverage: Coverage): string {
  return [
    `Phantom's repair machinery keeps minting no-diff reslice children for empty-diff parents — ${cell.units} distinct work items recorded ${cell.rows} handoff(s) on ${backendLabel(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one parent dispatch whose run produced no proposal diff — outcome 'empty-diff' with the diagnostic-no-proposal learning label or none — so repairHandoffFromDispatchEvent classified it 'no-diff-reslice' and the journal recorded the minted repair child (treatment 'baseline-reslice' or 'target-localization').${tierText(cell)}${sourceText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why parents keep finishing with no diff: join the example parent item ids to metrics/jobs.jsonl under the fleet runs directory and to the dispatch production ledger for their outcomes and diffs. Check whether the empty diffs cluster on a task shape the fleet keeps minting (too-vague goals, wrong-repo scoping, work another job already landed), on ${cell.backend === 'unrecorded' ? 'a producer the journal predates provenance for' : `the '${cell.backend}' engine's output in this repo`}, or on a source class — the recorded source tallies name which intake keeps feeding unworkable items. The reslice treatments, the eligibility fold and the repair lifecycle are this repository's own (src/core/fleet/repair-handoff-journal.ts, generated-repair-lifecycle.ts, proposal-repair-work.ts); dispatchd, launch.sh and publish.sh are pinned ops machinery. What this repository owns is the proposal pipeline and work-item scoping that decides what parents get dispatched, and the repair treatment selection that decides how a no-diff parent gets re-cut.`,
    '',
    `Decide whether the pattern is producer quality (fix the intake or routing), repair coverage (the reslice treatments not reaching the right work), or legitimately unworkable items the queue should stop minting — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

function captureErrorPrompt(cell: RepairHandoffCell, coverage: Coverage): string {
  return [
    `Phantom's repair machinery keeps minting capture-repair children for proposal-capture-error parents — ${cell.units} distinct work items recorded ${cell.rows} handoff(s) on ${backendLabel(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one parent dispatch whose proposal capture errored — outcome 'proposal-capture-error' — so repairHandoffFromDispatchEvent classified it 'capture-repair' and the journal recorded the minted repair child. Only 'self', 'issue' and 'goal' sources are eligible for this class.${tierText(cell)}${sourceText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find which capture stage keeps erroring: the proposal capture path lives in this repository under src/core — grep for the capture/proposal pipeline the dispatch outcomes feed (the run-proposal-outcome basis events the daemon folds in src/core/daemon/loop.ts), then join the example parent item ids to metrics/jobs.jsonl for their recorded reasons. Check whether the errors cluster on diff size or file count, on a specific ${cell.backend === 'unrecorded' ? 'producer' : `'${cell.backend}'`} output shape the capture cannot parse, on encoding or path edge cases, or on a capture stage that throws before recording why. The eligibility fold, the repair treatments and the repair lifecycle are this repository's own; dispatchd and the launcher are pinned ops machinery.`,
    '',
    `Decide whether the pattern is a capture-path bug this repo owns, an input contract the producers violate, or machinery state only a person can fix — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

function gateBlockedPrompt(cell: RepairHandoffCell, coverage: Coverage): string {
  return [
    `Phantom's repair machinery keeps minting capture-repair children for gate-blocked parents — ${cell.units} distinct work items recorded ${cell.rows} handoff(s) on ${backendLabel(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one parent dispatch whose proposal the completeness/diff gate blocked — outcome 'gate-blocked' with capture-ish signals (completenessGateRuns or diffFiles recorded, or capture/gate wording in the reason or route reason) — so repairHandoffFromDispatchEvent classified it 'capture-repair' and the journal recorded the minted repair child. Only 'self', 'issue' and 'goal' sources are eligible for this class.${tierText(cell)}${sourceText(cell)}${examplesText(cell)}${seenText(cell)}${boundText(cell)}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find whether the gate misfires or the work deserves blocking: the completeness and diff gates live in this repository — find the gate thresholds and the signals repairHandoffFromDispatchEvent reads (runEventSummary.actionCounts, diffFiles, reason and routeReason text), then join the example parent item ids to metrics/jobs.jsonl and the dispatch production ledger for what the blocked proposals actually contained. Check whether legitimate diffs keep failing the thresholds, whether producers keep submitting sub-gate work the intake should filter earlier, or whether the gate-blocked → capture-repair routing itself is too eager. The eligibility fold and repair lifecycle are this repository's own; dispatchd, launch.sh and the gate's host-side enforcement are pinned ops machinery where applicable.`,
    '',
    `Decide whether the pattern is a miscalibrated gate, an intake producing unworkable proposals, or correctly-blocked work — and fix what lives here. ${NO_CHANGE}`,
  ].join('\n');
}

const TITLES: Record<RepairHandoffOutcome, (backend: string) => string> = {
  'empty-diff': (backend) => `Empty-diff parents keep needing repair reslices on ${backend}`,
  'proposal-capture-error': (backend) => `Proposal capture keeps erroring into repair children on ${backend}`,
  'gate-blocked': (backend) => `The proposal gate keeps blocking work into repair children on ${backend}`,
};

const PROMPTS: Record<RepairHandoffOutcome, (cell: RepairHandoffCell, coverage: Coverage) => string> = {
  'empty-diff': emptyDiffPrompt,
  'proposal-capture-error': captureErrorPrompt,
  'gate-blocked': gateBlockedPrompt,
};

function repairHandoffItem(cell: RepairHandoffCell, repo: string, coverage: Coverage): CloudBacklogItem {
  const backend = cell.backend === 'unrecorded' ? 'unrecorded-backend' : cell.backend;
  const id = `fleet-repair-handoff-${createHash('sha256').update(`repair-handoff:${cell.repoName}:${cell.parentOutcome}:${backend}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: TITLES[cell.parentOutcome](cell.backend).slice(0, MAX_TITLE_CHARS),
    prompt: PROMPTS[cell.parentOutcome](cell, coverage),
    area: 'repair-handoff',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the repair-handoff journals' recurring
 * (repo, outcome, backend) cells. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function repairHandoffBacklogItems(opts: RepairHandoffItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const targetName = fleetRepoName(repo);
    if (targetName === '') return [];
    const home = opts.homeDir ?? homedir();
    // The writer's own resolution: homedir()/.ashlr/fleet, never
    // $ASHLR_HOME — an ASHLR_HOME-redirected read would miss the real
    // journals entirely.
    const fleetDir = opts.fleetDir ?? join(home, '.ashlr', 'fleet');
    if (typeof fleetDir !== 'string' || fleetDir === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? REPAIR_HANDOFF_WINDOW_MS;

    // Both journal files are read unconditionally — a missing one is
    // the writer's normal state (no handoffs yet, or a fresh home).
    const reads = await Promise.all(
      [V1_FILE, V2_FILE].map((name) => readLedgerTail(join(fleetDir, name), REPAIR_HANDOFF_TAIL_BYTES)),
    );
    const rows: RepairHandoffRow[] = [];
    let invalidRows = 0;
    let truncatedFiles = 0;
    let unreadableFiles = 0;
    for (const read of reads) {
      if (read.state !== 'read') {
        // A file that vanished between stat and open is a non-event;
        // anything else unreadable is stated, never guessed.
        if (read.state !== 'missing') unreadableFiles += 1;
        continue;
      }
      if (read.truncated) truncatedFiles += 1;
      const parsed = parseRepairHandoffLedger(read.text);
      rows.push(...parsed.rows);
      invalidRows += parsed.invalidRows;
    }
    if (rows.length === 0) return [];

    const lowerBound = truncatedFiles > 0;
    const folded = foldRepairHandoffCells(rows, { nowMs, windowMs, repoName: targetName }, lowerBound);
    const recurring = folded.filter(
      (cell) => cell.units >= REPAIR_HANDOFF_MIN_UNITS && cell.days.size >= REPAIR_HANDOFF_MIN_DAYS,
    );
    if (recurring.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? REPAIR_HANDOFF_BACKLOG_MAX_ITEMS, REPAIR_HANDOFF_ITEM_HARD_MAX));
    const coverage: Coverage = { invalidRows, unreadableFiles };
    return recurring.slice(0, limit).map((cell) => repairHandoffItem(cell, repo, coverage));
  } catch {
    return [];
  }
}
