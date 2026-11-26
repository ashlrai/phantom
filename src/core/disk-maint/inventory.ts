/**
 * disk-maint inventory - the read-only answer to "what could be reclaimed
 * here, who owns it, how old is it and how big". Every item the maintenance
 * plan would reclaim, with age, ownership and size, plus the worktrees and
 * protected paths that were excluded and why.
 *
 * It builds on the same plan scan (`planDiskMaint`), the same policy and the
 * same protect-list, and it has no apply path at all: nothing here deletes,
 * moves or writes. The report says `apply: false` and means it - the only
 * write any caller can make is printing.
 *
 * Ownership is attributed from names and the jobs ledger, never guessed:
 *
 *   job     - per-job artifacts: sidecar logs (`JOB.log`), archived results
 *             (`JOB.publish.prev-<ts>`) and worktree folders (`wt/JOB`). The
 *             lane comes from the job's own ledger row (lane|pool|arm); it
 *             stays null when no readable row names one.
 *   lane    - per-lane native profile state (`native-profiles/<lane>`).
 *   project - a named checkout that owns its own rebuildable output:
 *             side-project `.venv` trees, bridge repo `target/` dirs and the
 *             hub `.claude` session cache.
 *   fleet   - shared artifacts no single owner can claim: rolling logs,
 *             ashlr logs, caches, staging and recovery copies.
 *
 * Exclusions are reported, not dropped silently. Worktrees that are still
 * open, unfinished, unpinned but young, pinned, or whose state cannot be
 * proven stay out of the items and are listed with a plain reason - and an
 * unreadable ledger keeps every worktree excluded and lane ownership null,
 * because unknowns never count as reclaimable.
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ledgerLane } from '../fleet/empty-cause.js';
import { ledgerJobId } from '../fleet/jobs-ledger-dialect.js';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';
import { isKeptWorktree, readKeptWorktrees, type KeptWorktrees } from '../worktree-retention.js';
import { classifyWorktree, DISK_MAX_JOBS_BYTES, parseJobLedger, type WorktreeState } from '../../cli/disk.js';
import {
  artifactJobName, DEFAULT_POLICY, JOB_SIDECAR, planDiskMaint, protectedReason, protectedRoots,
  resolveMaintRoots, type MaintAction, type MaintClassId, type MaintDeps, type MaintRoots,
} from './plan.js';

export const DISK_INVENTORY_SCHEMA = 'disk-inventory.v1';
/** Human view: the largest items and owners shown; --json prints every one. */
export const DISK_INVENTORY_MAX_ITEM_LINES = 30;
export const DISK_INVENTORY_MAX_OWNER_LINES = 15;
export const DISK_INVENTORY_MAX_EXCLUDED_LINES = 20;
const HOUR_MS = 3_600_000;

export type InventoryOwnerKind = 'lane' | 'job' | 'project' | 'fleet';

/** Who owns one artifact. `lane` is the owning job's lane; null when unproven. */
export interface InventoryOwner { kind: InventoryOwnerKind; id: string | null; lane: string | null }

export interface InventoryItem {
  path: string;
  class: MaintClassId;
  action: MaintAction;
  bytes: number;
  /** Whole days from the item's own freshness signal (mtime, or the job's finish); null when unknown. */
  ageDays: number | null;
  mtimeMs: number | null;
  owner: InventoryOwner;
  reason: string;
}

export type ExcludedWorktreeReason =
  | 'still-open' | 'state-unknown' | 'no-finish-record' | 'pinned' | 'too-new' | 'age-unknown' | 'not-merged';

/** A worktree the reclaim classes keep. `ledgerState` is the ledger's own outcome word, null when unproven. */
export interface ExcludedWorktree {
  name: string;
  root: 'runs' | 'jobs';
  state: WorktreeState;
  ledgerState: string | null;
  reason: ExcludedWorktreeReason;
}

/** One owner's or lane's share of the reclaimable bytes. */
export interface OwnerRollup {
  /** Stable display key: `lane:<id>`, `job:<id>`, `project:<id>` or `fleet`. */
  owner: string;
  kind: InventoryOwnerKind;
  id: string | null;
  lane: string | null;
  items: number;
  bytes: number;
  oldestAgeDays: number | null;
}

export interface DiskInventoryV1 {
  schema: typeof DISK_INVENTORY_SCHEMA;
  generatedAt: string;
  /** Always false: the inventory only reads; there is no apply path. */
  apply: false;
  roots: MaintRoots;
  freeGb: number | null;
  /** DISKGUARD reuse line - reported for context, never changed. */
  diskguardReuseOnlyGb: number;
  jobsSource: Source;
  /** Largest first; every reclaimable item from every enabled class. */
  items: InventoryItem[];
  /** The same bytes folded by owner, largest first. */
  owners: OwnerRollup[];
  /** The same bytes folded by lane, largest first; jobs and profile state with a proven lane only. */
  lanes: OwnerRollup[];
  totals: {
    items: number;
    bytes: number;
    complete: boolean;
    oldestAgeDays: number | null;
    /** Bytes whose owner has no provable lane (fleet, project, unlabeled jobs). */
    unattributedBytes: number;
  };
  excluded: {
    /** Active, unfinished, young, pinned and unprovable worktrees, with a plain reason each. */
    worktrees: ExcludedWorktree[];
    /** Paths the protect-list refused during the scan - evidence, not errors. */
    protectedPaths: { path: string; reason: string }[];
    /** Gated classes holding bytes behind `--allow`, listed so no byte hides. */
    gated: { id: MaintClassId; bytes: number }[];
  };
  /** Plain gaps in what was read, so unknown stays visible. */
  gaps: string[];
}

const FLEET_OWNER: InventoryOwner = { kind: 'fleet', id: null, lane: null };

/**
 * Pure: job id -> lane from the ledger's lane|pool|arm alias. The last row
 * that names a lane wins; jobs no readable row names stay unattributed.
 */
export function laneByJob(text: string): Map<string, string> {
  const lanes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    let row: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(line);
      row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { continue; }
    if (row === null) continue;
    const id = ledgerJobId(row);
    const lane = ledgerLane(row);
    if (id !== null && lane !== null) lanes.set(id, lane);
  }
  return lanes;
}

/** First path segment of `path` under `root`, null when it is not under root. */
const segmentUnder = (root: string, path: string): string | null => {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep)[0]!;
};

/** Strip trailing rotation suffixes so `JOB.log.rotate-2.gz` still reads as `JOB.log`. */
const unrotated = (name: string): string => {
  for (let current = name;;) {
    const next = current.replace(/\.(gz|\d+|rotate-\d+(\.gz)?)$/i, '');
    if (next === current) return next;
    current = next;
  }
};

/**
 * Pure: who owns one reclaimable candidate, from its path, its class and the
 * ledger's lane map. Anything that cannot be attributed is fleet-owned, and
 * a job's lane stays null when the ledger does not name one - never guessed.
 */
export function artifactOwner(
  path: string,
  classId: MaintClassId,
  roots: MaintRoots,
  laneOfJob: (job: string) => string | null,
): InventoryOwner {
  const name = basename(path);
  const jobOwner = (job: string | null): InventoryOwner =>
    job === null ? FLEET_OWNER : { kind: 'job', id: job, lane: laneOfJob(job) };
  switch (classId) {
    case 'run-logs':
      return jobOwner(JOB_SIDECAR.exec(unrotated(name))?.[1] ?? null);
    case 'job-artifacts':
      return jobOwner(artifactJobName(name));
    case 'worktrees-runs': case 'worktrees-jobs':
      return jobOwner(name);
    case 'agent-sessions': {
      const lane = segmentUnder(join(roots.ashlrDir, 'native-profiles'), path);
      return lane === null ? FLEET_OWNER : { kind: 'lane', id: lane, lane };
    }
    case 'bridge-targets': {
      const repo = segmentUnder(join(roots.runsDir, 'repos'), path);
      return repo === null ? FLEET_OWNER : { kind: 'project', id: repo, lane: null };
    }
    case 'venvs': {
      const project = basename(dirname(path));
      return project === '' ? FLEET_OWNER : { kind: 'project', id: project, lane: null };
    }
    case 'hub-claude':
      return { kind: 'project', id: roots.hubDir ? basename(roots.hubDir) : 'ashlr-hub', lane: null };
    default:
      // ashlr-logs, caches, recovery-dirs, staging: shared, no single owner.
      return FLEET_OWNER;
  }
}

/** Pure: items folded by owner key, largest first. */
function foldByOwner(items: readonly InventoryItem[]): OwnerRollup[] {
  const map = new Map<string, OwnerRollup>();
  for (const item of items) {
    const { kind, id, lane } = item.owner;
    const key = kind === 'fleet' ? 'fleet' : `${kind}:${id ?? ''}`;
    const roll = map.get(key) ?? { owner: key, kind, id, lane: null, items: 0, bytes: 0, oldestAgeDays: null };
    roll.items++;
    roll.bytes += item.bytes;
    if (item.ageDays !== null && (roll.oldestAgeDays === null || item.ageDays > roll.oldestAgeDays)) roll.oldestAgeDays = item.ageDays;
    if (lane !== null) roll.lane = lane;
    map.set(key, roll);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes || a.owner.localeCompare(b.owner));
}

/** Pure: items folded by lane (jobs carry their lane; profile state is its own), plus the unattributed remainder. */
function foldByLane(items: readonly InventoryItem[]): { lanes: OwnerRollup[]; unattributedBytes: number } {
  const map = new Map<string, OwnerRollup>();
  let unattributedBytes = 0;
  for (const item of items) {
    const lane = item.owner.kind === 'lane' ? item.owner.id : item.owner.kind === 'job' ? item.owner.lane : null;
    if (lane === null) { unattributedBytes += item.bytes; continue; }
    const roll = map.get(lane) ?? { owner: lane, kind: 'lane', id: lane, lane, items: 0, bytes: 0, oldestAgeDays: null };
    roll.items++;
    roll.bytes += item.bytes;
    if (item.ageDays !== null && (roll.oldestAgeDays === null || item.ageDays > roll.oldestAgeDays)) roll.oldestAgeDays = item.ageDays;
    map.set(lane, roll);
  }
  const lanes = [...map.values()].sort((a, b) => b.bytes - a.bytes || a.owner.localeCompare(b.owner));
  return { lanes, unattributedBytes };
}

interface LedgerRecord { state: string | null; finishMs: number | null; finishEmpty: boolean }

/**
 * Read-only: worktrees both reclaim classes keep, with one plain reason each.
 * Mirrors the plan's own rules exactly (state set per root, finish age over
 * the policy minimum, then the pin file), so anything this scan keeps, the
 * plan kept too, and anything reclaimable shows up in the plan's items.
 * Protected worktree paths are skipped here: the scan already recorded them
 * as protect-list refusals.
 */
function scanExcludedWorktrees(opts: {
  roots: MaintRoots;
  now: number;
  minAgeHours: number;
  ledger: Map<string, LedgerRecord> | null;
  kept: (dir: string) => boolean;
  protectedRootsList: readonly string[];
  onUnreadable: (message: string) => void;
}): ExcludedWorktree[] {
  const scanRoots: Array<{ root: 'runs' | 'jobs'; dir: string; states: ReadonlySet<string> }> = [
    { root: 'runs', dir: join(opts.roots.runsDir, 'wt'), states: new Set(['merged', 'empty']) },
    { root: 'jobs', dir: opts.roots.wtDir, states: new Set(['merged']) },
  ];
  const out: ExcludedWorktree[] = [];
  for (const root of scanRoots) {
    let entries;
    try { entries = readdirSync(root.dir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.onUnreadable(`The ${root.root === 'runs' ? 'runs' : 'job'} worktree folder could not be listed, so its excluded worktrees are missing here.`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      // The same name rules as the plan's worktree scanners.
      if (entry.name.startsWith('guardian-') || /\.keep$/i.test(entry.name) ||
        entry.name.includes('/') || entry.name.includes('\\')) continue;
      const path = join(root.dir, entry.name);
      if (protectedReason(path, opts.roots, opts.protectedRootsList)) continue;
      const record = opts.ledger?.get(entry.name);
      const state: WorktreeState = opts.ledger === null ? 'unknown' : classifyWorktree(record);
      const keptOut = (reason: ExcludedWorktreeReason): void => {
        out.push({ name: entry.name, root: root.root, state, ledgerState: record?.state ?? null, reason });
      };
      if (root.states.has(state)) {
        const finishMs = record?.finishMs ?? null;
        if (finishMs === null) { keptOut('age-unknown'); continue; }
        if ((opts.now - finishMs) / HOUR_MS <= opts.minAgeHours) { keptOut('too-new'); continue; }
        if (opts.kept(path)) { keptOut('pinned'); continue; }
        continue; // Reclaimable: it is in the plan's worktree items.
      }
      const reason: ExcludedWorktreeReason = state === 'open' ? 'still-open'
        : state === 'unknown' ? 'state-unknown'
        : state === 'empty' ? 'not-merged'
        : 'no-finish-record';
      keptOut(reason);
    }
  }
  return out.sort((a, b) => a.root.localeCompare(b.root) || a.name.localeCompare(b.name));
}

/**
 * One read-only inventory of reclaimable fleet artifacts: the maintenance
 * plan's candidates with ownership, plus every exclusion named. Reads the
 * jobs ledger and the pin file once and shares them with the plan scan.
 */
export async function buildDiskInventory(deps: MaintDeps = {}): Promise<DiskInventoryV1> {
  const now = deps.now ?? Date.now();
  const roots = deps.roots ?? resolveMaintRoots();
  const policy = { ...DEFAULT_POLICY, ...deps.policy };

  // One shared read of the ledger and the pins for the plan scan, the lane
  // map and the worktree exclusions - never two reads that can disagree.
  let jobs: { state: Source; text: string } | undefined;
  const readJobs = async (path: string): Promise<{ state: Source; text: string }> =>
    jobs ??= await (deps.readJobs ?? ((p: string) => readSource(p, DISK_MAX_JOBS_BYTES, true)))(path);
  let pins: KeptWorktrees;
  try { pins = await (deps.readPins ?? readKeptWorktrees)(); } catch { pins = { paths: [], valid: false }; }
  const kept = deps.kept ?? ((dir: string) => isKeptWorktree(dir, pins));

  const plan = await planDiskMaint({ ...deps, roots, readJobs, readPins: async () => pins, kept });
  const ledger = jobs !== undefined && jobs.state === 'healthy' ? parseJobLedger(jobs.text) : null;
  const laneMap = laneByJob(jobs !== undefined && jobs.state === 'healthy' ? jobs.text : '');
  const laneOfJob = (job: string): string | null => laneMap.get(job) ?? null;

  const items: InventoryItem[] = plan.classes
    .filter(cls => cls.enabled)
    .flatMap(cls => cls.candidates.map(candidate => ({
      path: candidate.path,
      class: cls.id,
      action: candidate.action,
      bytes: candidate.bytes,
      ageDays: candidate.ageDays,
      mtimeMs: candidate.mtimeMs,
      owner: artifactOwner(candidate.path, cls.id, roots, laneOfJob),
      reason: candidate.reason,
    })))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  const owners = foldByOwner(items);
  const { lanes, unattributedBytes } = foldByLane(items);

  const gaps: string[] = [];
  if (plan.jobsSource !== 'healthy') gaps.push('The jobs ledger could not be read, so every worktree stays kept and job owners show without a lane.');
  if (!plan.totals.complete) gaps.push('Some sizes are partial or unmeasured, so byte counts are floors.');
  const excludedWorktrees = scanExcludedWorktrees({
    roots, now, minAgeHours: policy.worktreeMinAgeHours, ledger, kept,
    protectedRootsList: protectedRoots(roots), onUnreadable: message => gaps.push(message),
  });

  const oldestAgeDays = items.reduce<number | null>(
    (max, item) => item.ageDays !== null && (max === null || item.ageDays > max) ? item.ageDays : max, null);
  return {
    schema: DISK_INVENTORY_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    apply: false,
    roots,
    freeGb: plan.freeGb,
    diskguardReuseOnlyGb: plan.diskguardReuseOnlyGb,
    jobsSource: plan.jobsSource,
    items,
    owners,
    lanes,
    totals: {
      items: items.length,
      bytes: items.reduce((sum, item) => sum + item.bytes, 0),
      complete: plan.totals.complete,
      oldestAgeDays,
      unattributedBytes,
    },
    excluded: {
      worktrees: excludedWorktrees,
      protectedPaths: plan.refused,
      gated: plan.classes
        .filter(cls => cls.gated && !cls.enabled && cls.bytes > 0)
        .map(cls => ({ id: cls.id, bytes: cls.bytes })),
    },
    gaps,
  };
}

// ── human view ────────────────────────────────────────────────────────────────────────────────────────────

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Decimal GB like the fleet disk views; a measured sub-0.1 GB stays visible. */
const gb = (bytes: number): string => {
  const value = round1(bytes / 1e9);
  return `${value === 0 && bytes > 0 ? '<0.1' : value} GB`;
};

/** Collapse the operator's home to `~` for display; the JSON side uses sanitizePublicJson. */
function displayDir(path: string): string {
  try {
    const home = homedir().replace(/[/\\]+$/, '');
    if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  } catch { /* no resolvable home - print the path as given */ }
  return path;
}

const ageWords = (ageDays: number | null): string => ageDays === null ? 'age unknown' : `${ageDays} ${ageDays === 1 ? 'day' : 'days'} old`;

/** One owner in plain words: `job RQ-1 (lane zai)`, `lane zai`, `project hub`, `fleet`. */
function ownerWords(owner: InventoryOwner): string {
  switch (owner.kind) {
    case 'job': return `job ${owner.id ?? 'unknown'}${owner.lane === null ? '' : ` (lane ${owner.lane})`}`;
    case 'lane': return `lane ${owner.id ?? 'unknown'}`;
    case 'project': return `project ${owner.id ?? 'unknown'}`;
    default: return 'fleet';
  }
}

/** One exclusion reason in plain words. */
function reasonWords(excluded: ExcludedWorktree): string {
  const detail = excluded.ledgerState !== null && excluded.ledgerState !== excluded.state
    ? ` (ledger says ${excluded.ledgerState})` : '';
  switch (excluded.reason) {
    case 'still-open': return `still open${detail}`;
    case 'state-unknown': return 'job record unread, kept';
    case 'no-finish-record': return `no finished record${detail}`;
    case 'pinned': return 'pinned, kept';
    case 'too-new': return 'finished recently, kept';
    case 'age-unknown': return 'finish time unknown, kept';
    case 'not-merged': return 'finished empty; the job worktree root keeps only merged';
  }
}

/**
 * Human lines, plain words, largest first. Pure - unit-testable without I/O.
 * Bounded to the largest items, owners and exclusions; `--json` prints every one.
 */
export function formatDiskInventory(report: DiskInventoryV1): string[] {
  const lines: string[] = ['disk inventory — reads only, deletes nothing'];
  lines.push(`free now: ${report.freeGb === null ? 'unknown' : `${report.freeGb} GB`} (DISKGUARD reuse line: ${report.diskguardReuseOnlyGb} GB, unchanged)`);
  if (report.jobsSource !== 'healthy') {
    lines.push(`jobs ledger ${report.jobsSource === 'missing' ? 'missing' : 'unreadable'} — worktree states stay unknown and job owners show without a lane`);
  }
  const { items, bytes, complete, oldestAgeDays } = report.totals;
  if (items === 0) {
    lines.push('reclaimable: nothing found');
  } else {
    lines.push(`reclaimable: ${gb(bytes)} in ${plural(items, 'item')}, oldest ${oldestAgeDays === null ? 'unknown' : `${oldestAgeDays} ${oldestAgeDays === 1 ? 'day' : 'days'}`}${complete ? '' : ' (partial scan — byte counts are floors)'}`);
  }
  for (const gap of report.gaps) lines.push(`note: ${gap}`);

  if (report.owners.length > 0) {
    lines.push('by owner:');
    for (const roll of report.owners.slice(0, DISK_INVENTORY_MAX_OWNER_LINES)) {
      lines.push(`  ${roll.owner === 'fleet' ? 'fleet' : ownerWords({ kind: roll.kind, id: roll.id, lane: roll.lane })}: ${gb(roll.bytes)} in ${plural(roll.items, 'item')}`);
    }
    if (report.owners.length > DISK_INVENTORY_MAX_OWNER_LINES) {
      lines.push(`  …and ${report.owners.length - DISK_INVENTORY_MAX_OWNER_LINES} more (--json prints all)`);
    }
  }
  if (report.lanes.length > 0) {
    lines.push('by lane:');
    for (const roll of report.lanes) lines.push(`  ${roll.id}: ${gb(roll.bytes)} in ${plural(roll.items, 'item')}`);
    lines.push(`  no lane recorded: ${gb(report.totals.unattributedBytes)}`);
  }

  if (report.items.length > 0) {
    lines.push('largest items:');
    for (const item of report.items.slice(0, DISK_INVENTORY_MAX_ITEM_LINES)) {
      lines.push(`  ${displayDir(item.path)} — ${gb(item.bytes)}, ${ageWords(item.ageDays)} — ${item.class} — ${ownerWords(item.owner)}`);
    }
    if (report.items.length > DISK_INVENTORY_MAX_ITEM_LINES) {
      lines.push(`  …and ${report.items.length - DISK_INVENTORY_MAX_ITEM_LINES} more (--json prints every item)`);
    }
  }

  lines.push('excluded, kept:');
  const worktrees = report.excluded.worktrees;
  if (worktrees.length === 0) lines.push('  worktrees: none excluded');
  else {
    lines.push(`  worktrees: ${plural(worktrees.length, 'folder')}:`);
    for (const excluded of worktrees.slice(0, DISK_INVENTORY_MAX_EXCLUDED_LINES)) {
      lines.push(`    ${excluded.name} (${excluded.root} root) — ${reasonWords(excluded)}`);
    }
    if (worktrees.length > DISK_INVENTORY_MAX_EXCLUDED_LINES) {
      lines.push(`    …and ${worktrees.length - DISK_INVENTORY_MAX_EXCLUDED_LINES} more (--json prints all)`);
    }
  }
  lines.push(`  protected paths refused: ${plural(report.excluded.protectedPaths.length, 'path')}`);
  for (const gated of report.excluded.gated) {
    lines.push(`  gated: ${gated.id} holds ${gb(gated.bytes)} behind --allow ${gated.id}`);
  }
  lines.push('deletes nothing; phm disk-maint --apply reclaims the listed classes when you choose.');
  return lines;
}
