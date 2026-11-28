/**
 * Self-improvement backlog (unit C1): built-in items (improvement-backlog.ts)
 * plus operator/Leader items at `<cloudHome>/backlog.json`. An item is
 * "claimed" by its newest task; it becomes available again 3 days after
 * that task ends closed/failed/expired — doubling per consecutive unmerged
 * ending up to CLOUD_BACKLOG_RETRY_MAX_MS — never after merged or a
 * "no-change" report. Ordering is priority, then measured metric leverage
 * per area kind, then —
 * for kinds the metric ledger never measured — merge/revert outcomes folded
 * from the tasks' own post-merge evidence (improve/area-outcomes.ts), then
 * file order.
 *
 * File: `{ "v": 1, "items": CloudBacklogItem[] }`, 0600, at most
 * CLOUD_BACKLOG_MAX_USER_ITEMS items. Readers validate every item and skip
 * the bad ones, so one hand-mangled entry cannot hide the rest.
 */
import { join } from 'node:path';

import { kindLeverage, kindOf, readLedger, scoreOutcomes, validateMetricSpec, type MetricSpec } from '../improve/outcomes.js';
import { backlogAreaOutcomes, type AreaOutcomeCell } from '../improve/area-outcomes.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { BUILTIN_IMPROVEMENT_BACKLOG } from './improvement-backlog.js';
import { cloudHome, ensureCloudDirectory, listCloudTasks, readCloudJsonFile } from './store.js';
import {
  CLOUD_PROMPT_MAX_CHARS,
  CLOUD_REPO_PATTERN,
  isCloudRecord,
  isValidIsoTimestamp,
  sameCloudRepo,
  type CloudBacklogDoneWhen,
  type CloudBacklogItem,
  type CloudBacklogView,
  type CloudTaskState,
  type CloudTaskV1,
} from './types.js';

const CLOUD_BACKLOG_FILE = 'backlog.json';
export const CLOUD_BACKLOG_MAX_USER_ITEMS = 200;
/** A closed/failed/expired item is retried after this long (a merged one never is). */
export const CLOUD_BACKLOG_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * The retry delay's ceiling: each consecutive unmerged ending doubles the
 * wait from CLOUD_BACKLOG_RETRY_MS, capped here — a persistently failing
 * item still retries (about monthly) instead of spending a session every
 * 3 days forever, while a one-off ending keeps the 3-day cadence.
 */
export const CLOUD_BACKLOG_RETRY_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const BACKLOG_VERSION = 1;
/** 200 items × a 20 000-char prompt, with room for JSON escaping. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_TITLE_CHARS = 200;
const MAX_AREA_CHARS = 40;

const RETRYABLE: readonly CloudTaskState[] = ['closed', 'failed', 'expired'];

export function cloudBacklogPath(): string {
  return join(cloudHome(), CLOUD_BACKLOG_FILE);
}

/** A clean copy of a valid item, or null. Titles and areas are trimmed; nothing else is rewritten. */
export function validBacklogItem(value: unknown): CloudBacklogItem | null {
  if (!isCloudRecord(value)) return null;
  const id = value['id'];
  const title = typeof value['title'] === 'string' ? value['title'].trim() : '';
  const prompt = typeof value['prompt'] === 'string' ? value['prompt'] : '';
  const area = typeof value['area'] === 'string' ? value['area'].trim() : '';
  const priority = value['priority'];
  const repo = value['repo'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (title === '' || title.length > MAX_TITLE_CHARS) return null;
  if (prompt.trim() === '' || prompt.length > CLOUD_PROMPT_MAX_CHARS) return null;
  if (area === '' || area.length > MAX_AREA_CHARS) return null;
  if (priority !== 1 && priority !== 2 && priority !== 3) return null;
  if (repo !== undefined && (typeof repo !== 'string' || !CLOUD_REPO_PATTERN.test(repo))) return null;
  let metric: MetricSpec | undefined;
  if (value['metric'] !== undefined) {
    try { metric = validateMetricSpec(value['metric']); } catch { return null; }
  }
  let doneWhen: CloudBacklogDoneWhen | undefined;
  if (value['doneWhen'] !== undefined) {
    doneWhen = validDoneWhen(value['doneWhen']) ?? undefined;
    if (!doneWhen) return null;
  }
  const assertedAt = isValidIsoTimestamp(value['assertedAt']) ? value['assertedAt'] : undefined;
  return { id, title, prompt, area, priority, ...(repo !== undefined ? { repo } : {}), ...(metric ? { metric } : {}), ...(doneWhen ? { doneWhen } : {}), ...(assertedAt !== undefined ? { assertedAt } : {}) };
}

/** A repo-relative path of plain segments (no `..`, no absolute forms) and a short literal, or an issue number. */
export function validDoneWhen(value: unknown): CloudBacklogDoneWhen | null {
  if (!isCloudRecord(value)) return null;
  const { path, contains, issue } = value;
  if (issue !== undefined) {
    return path === undefined && contains === undefined && Number.isSafeInteger(issue) && (issue as number) > 0 ? { issue: issue as number } : null;
  }
  if (typeof path !== 'string' || path.length > 300 || !/^[A-Za-z0-9_@.-]+(\/[A-Za-z0-9_@.-]+)*$/.test(path)) return null;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  if (contains !== undefined && (typeof contains !== 'string' || contains === '' || contains.length > 200)) return null;
  return contains === undefined ? { path } : { path, contains };
}

/** Dedupe key for titles: case, punctuation and spacing do not make an item new. */
function normaliseBacklogTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The operator/Leader items on disk, validated, deduped, capped. Total: any bad file reads as empty. */
export function readUserBacklogItems(): CloudBacklogItem[] {
  const value = readCloudJsonFile(cloudBacklogPath(), MAX_FILE_BYTES);
  // A bare array is accepted too: it is what an operator writes by hand.
  const raw = Array.isArray(value) ? value
    : isCloudRecord(value) && Array.isArray(value['items']) ? value['items'] as unknown[]
    : [];
  const ids = new Set(BUILTIN_IMPROVEMENT_BACKLOG.map((item) => item.id));
  const titles = new Set(BUILTIN_IMPROVEMENT_BACKLOG.map((item) => normaliseBacklogTitle(item.title)));
  const items: CloudBacklogItem[] = [];
  for (const entry of raw) {
    if (items.length >= CLOUD_BACKLOG_MAX_USER_ITEMS) break;
    const item = validBacklogItem(entry);
    if (!item || ids.has(item.id) || titles.has(normaliseBacklogTitle(item.title))) continue;
    ids.add(item.id);
    titles.add(normaliseBacklogTitle(item.title));
    items.push(item);
  }
  return items;
}

/** Built-in first, then user items, each in file order: the tie-break after priority. */
function allItems(): CloudBacklogItem[] {
  return [...BUILTIN_IMPROVEMENT_BACKLOG, ...readUserBacklogItems()];
}

interface Claim {
  claimedBy: string | null;
  lastState: CloudTaskState | null;
}

/**
 * 3.15: what a claim is computed from — a task of EITHER delivery lane (a
 * cloud CloudTaskV1 or a devin/types.ts DevinTaskV1; both share these
 * fields and the same state words). Claims span both lanes, so an item a
 * Devin session is working on is never also handed to a cloud session, and
 * the reverse.
 */
export type BacklogClaimTask = Pick<CloudTaskV1, 'id' | 'backlogItemId' | 'createdAt' | 'updatedAt'> & Partial<Pick<CloudTaskV1, 'report' | 'repo' | 'pr' | 'supersededBy' | 'intake' | 'outcome'>> & {
  /** A cloud state, or Devin's extra in-progress `blocked` (waiting for Mason). */
  state: CloudTaskState | 'blocked';
};

/**
 * Backlog item id → its tasks newest-first. The sort is stable, so tasks
 * sharing a createdAt keep input order — the same pick per-item newest
 * selection always made, extended to the history the retry streak reads.
 */
function tasksByItem<T extends BacklogClaimTask>(tasks: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    if (!task.backlogItemId) continue;
    const group = groups.get(task.backlogItemId);
    if (group) group.push(task);
    else groups.set(task.backlogItemId, [task]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  return groups;
}

/** Consecutive unmerged endings at the head of a newest-first task list. */
function retryStreak(tasks: readonly BacklogClaimTask[]): number {
  let streak = 0;
  for (const task of tasks) {
    const state: CloudTaskState = task.state === 'blocked' ? 'running' : task.state;
    if (!RETRYABLE.includes(state) || task.report?.status === 'no-change') break;
    streak += 1;
  }
  return streak;
}

/** Wait before a retryable-ended item is claimable again: doubles per consecutive unmerged ending, capped. */
function retryDelayMs(streak: number): number {
  return Math.min(CLOUD_BACKLOG_RETRY_MS * 2 ** Math.max(0, streak - 1), CLOUD_BACKLOG_RETRY_MAX_MS);
}

function claimOf(item: CloudBacklogItem, tasks: readonly BacklogClaimTask[], nowMs: number): Claim {
  const task = tasks[0];
  if (!task) return { claimedBy: null, lastState: null };
  // A Devin session waiting for Mason is still in progress.
  const state: CloudTaskState = task.state === 'blocked' ? 'running' : task.state;
  // A session that reported "no-change" found the work already done; closing
  // its empty PR must not put the item back in rotation every few days.
  if (RETRYABLE.includes(state) && task.report?.status !== 'no-change') {
    // updatedAt is when the task last changed — for a terminal task, when it ended.
    const endedAt = Date.parse(task.updatedAt);
    const released = Number.isFinite(endedAt) && nowMs - endedAt >= retryDelayMs(retryStreak(tasks));
    return { claimedBy: released ? null : task.id, lastState: state };
  }
  // A merged end retires an item only until a producer asserts it again.
  // assertedAt later than the task's creation means evidence arrived after
  // the prompt was minted — evidence the merge cannot have covered — so the
  // item is claimable again rather than done for good. An item never
  // re-asserted (built-in, hand-written, or a producer that stopped seeing
  // its condition) has no later stamp and keeps done-for-good semantics.
  if (state === 'merged') {
    const asserted = Date.parse(item.assertedAt ?? '');
    const minted = Date.parse(task.createdAt);
    const released = Number.isFinite(asserted) && Number.isFinite(minted) && asserted > minted;
    return { claimedBy: released ? null : task.id, lastState: state };
  }
  // Non-terminal: in progress.
  return { claimedBy: task.id, lastState: state };
}

/**
 * Realized leverage per area from the improvement outcome ledger. An
 * unreadable or broken ledger means no evidence, so the static order stands.
 */
function areaLeverage(): Map<string, number | null> {
  try {
    const read = readLedger();
    return read.intact ? kindLeverage(scoreOutcomes(read.records)) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * Merge/revert outcomes per area kind for kinds the metric ledger cannot
 * see — every discovered item without a declared `metric` never registers
 * a proposal, so its area's leverage stays "unmeasured" forever. The fold
 * reuses observe-sync's checkout-free post-merge evidence (task outcomes,
 * fleet merge state, the revert journal) joined through `backlogItemId`;
 * an unreadable source contributes nothing, same fail-closed rule as
 * areaLeverage.
 */
function areaMergeOutcomes(tasks: readonly BacklogClaimTask[], items: readonly CloudBacklogItem[]): Map<string, AreaOutcomeCell> {
  try {
    return backlogAreaOutcomes(tasks, items);
  } catch {
    return new Map();
  }
}

/** Standing reverts an unmeasured area needs before its pick order drops behind clean areas. */
export const AREA_REVERT_DEMOTE_MIN = 2;

/**
 * Priority first (the operator's intent). Within a priority, areas whose
 * measured outcomes improved their metric go first, unmeasured areas next,
 * areas with a zero or negative measured record last; then file order.
 *
 * Kinds the metric ledger never measured fall back to merge/revert
 * evidence: an area whose items' carrier PRs keep ending in standing
 * reverts ranks with the measured-bad tier, and within the unmeasured tier
 * areas with more merges still standing order ahead of areas with none —
 * held merges are weak positive evidence (a repair landing is the expected
 * outcome), standing reverts are strong negative evidence (the change did
 * not hold), so only the latter demotes.
 */
function ordered<T extends CloudBacklogItem>(
  items: readonly T[],
  leverage: Map<string, number | null> = areaLeverage(),
  areaOutcomes: ReadonlyMap<string, AreaOutcomeCell> = new Map(),
): T[] {
  const tier = (area: string) => {
    const kind = kindOf(area);
    const v = leverage.get(kind) ?? null;
    if (v !== null) return v > 0 ? { t: 0, v } : { t: 2, v };
    const o = areaOutcomes.get(kind);
    if (o !== undefined && o.reverted >= AREA_REVERT_DEMOTE_MIN && o.reverted > o.held) {
      return { t: 2, v: -o.reverted };
    }
    return { t: 1, v: o?.held ?? 0 };
  };
  return items.map((item, index) => ({ item, index, ...tier(item.area) }))
    .sort((a, b) => a.item.priority - b.item.priority || a.t - b.t || b.v - a.v || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Per-kind merge/revert outcome cells for ordering; pass a pinned map to
 * fix the order in tests. Absent, the cells fold the tasks' own post-merge
 * evidence (see areaMergeOutcomes).
 */
export type BacklogOrderOutcomes = ReadonlyMap<string, AreaOutcomeCell>;

export function readCloudBacklog(tasks: readonly BacklogClaimTask[], now: Date, areaOutcomes?: BacklogOrderOutcomes): CloudBacklogView {
  const groups = tasksByItem(tasks);
  const nowMs = now.getTime();
  const all = allItems();
  const items = ordered(all, areaLeverage(), areaOutcomes ?? areaMergeOutcomes(tasks, all)).map((item) => ({ ...item, ...claimOf(item, groups.get(item.id) ?? [], nowMs) }));
  return { items, nextUp: items.find((item) => item.claimedBy === null)?.id ?? null };
}

/** Next unclaimed item for `repo`, highest priority first, then built-in order. */
export function nextBacklogItem(tasks: readonly BacklogClaimTask[], repo: string, now: Date, exclude: ReadonlySet<string> = new Set(), areaOutcomes?: BacklogOrderOutcomes): CloudBacklogItem | null {
  // An item without a repo targets whichever repo self-improvement is pointed at.
  return nextBacklogItemWhere(tasks, now, repo, (item, target) => !exclude.has(item.id) && sameCloudRepo(target, repo), areaOutcomes)?.item ?? null;
}

/**
 * 3.15: the next unclaimed item (claims across every lane's `tasks`) that
 * `accept` takes, highest priority first, then built-in order. `accept`
 * receives the item and the repo it resolves to — its own `repo`, else
 * `defaultRepo` (null = an item without a repo is skipped). Used by the Devin
 * fleet launcher to pick well-scoped work for a repo the grant covers.
 */
export function nextBacklogItemWhere(
  tasks: readonly BacklogClaimTask[],
  now: Date,
  defaultRepo: string | null,
  accept: (item: CloudBacklogItem, repo: string) => boolean,
  areaOutcomes?: BacklogOrderOutcomes,
): { item: CloudBacklogItem; repo: string } | null {
  const groups = tasksByItem(tasks);
  const nowMs = now.getTime();
  const all = allItems();
  for (const item of ordered(all, areaLeverage(), areaOutcomes ?? areaMergeOutcomes(tasks, all))) {
    const repo = item.repo ?? defaultRepo;
    if (repo === null) continue;
    if (claimOf(item, groups.get(item.id) ?? [], nowMs).claimedBy !== null) continue;
    if (accept(item, repo)) return { item, repo };
  }
  return null;
}

/**
 * Adds items (dedupe by id and by normalised title); returns how many were
 * new. Leader/operator entry point. Every accepted item is stamped
 * `assertedAt` with `now`, and an item whose id is already stored is
 * re-asserted in place — its prompt and options refresh to the producer's
 * latest evidence while id and title keep the dedupe invariants — so a
 * merged attempt that predates the new assertion releases its claim (see
 * claimOf). Re-assertions are not counted in the return value.
 */
export function appendUserBacklogItems(items: readonly CloudBacklogItem[], now: Date = new Date()): number {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const assertedAt = now.toISOString();
  const nowMs = now.getTime();
  let existing = readUserBacklogItems();
  const byId = new Map(existing.map((entry, index) => [entry.id, index] as const));
  const ids = new Set([...BUILTIN_IMPROVEMENT_BACKLOG, ...existing].map((item) => item.id));
  const titles = new Set([...BUILTIN_IMPROVEMENT_BACKLOG, ...existing].map((item) => normaliseBacklogTitle(item.title)));
  const fresh: CloudBacklogItem[] = [];
  let reasserted = 0;
  for (const entry of items) {
    const item = validBacklogItem(entry);
    if (!item) continue;
    const stored = byId.get(item.id);
    if (stored !== undefined) {
      // Same id is the same work item: refresh the spec and re-stamp the
      // assertion. id and title stay — they are the dedupe identity.
      existing[stored] = { ...item, id: existing[stored]!.id, title: existing[stored]!.title, assertedAt };
      reasserted += 1;
      continue;
    }
    if (ids.has(item.id) || titles.has(normaliseBacklogTitle(item.title))) continue;
    ids.add(item.id);
    titles.add(normaliseBacklogTitle(item.title));
    fresh.push({ ...item, assertedAt });
  }
  if (fresh.length === 0 && reasserted === 0) return 0;

  if (existing.length + fresh.length > CLOUD_BACKLOG_MAX_USER_ITEMS) {
    // Make room by retiring items that are finished for good (their newest
    // task merged and was never re-asserted since), oldest first — never an
    // item still waiting to run or one a producer keeps asserting.
    const groups = tasksByItem(listCloudTasks());
    let excess = existing.length + fresh.length - CLOUD_BACKLOG_MAX_USER_ITEMS;
    existing = existing.filter((item) => {
      if (excess > 0) {
        const claim = claimOf(item, groups.get(item.id) ?? [], nowMs);
        if (claim.lastState === 'merged' && claim.claimedBy !== null) {
          excess -= 1;
          return false;
        }
      }
      return true;
    });
  }
  const accepted = fresh.slice(0, Math.max(0, CLOUD_BACKLOG_MAX_USER_ITEMS - existing.length));
  if (accepted.length === 0 && reasserted === 0) return 0;
  ensureCloudDirectory();
  writePrivateFileAtomic(cloudBacklogPath(), `${JSON.stringify({ v: BACKLOG_VERSION, items: [...existing, ...accepted] }, null, 2)}\n`);
  return accepted.length;
}

/**
 * 3.15: remove one user item by id (a vetoed Leader `backlog.add`). Built-in
 * items cannot be removed. Returns whether an item was dropped.
 */
export function removeUserBacklogItem(itemId: string): boolean {
  if (typeof itemId !== 'string' || itemId.length === 0) return false;
  const existing = readUserBacklogItems();
  const kept = existing.filter((item) => item.id !== itemId);
  if (kept.length === existing.length) return false;
  ensureCloudDirectory();
  writePrivateFileAtomic(cloudBacklogPath(), `${JSON.stringify({ v: BACKLOG_VERSION, items: kept }, null, 2)}\n`);
  return true;
}
