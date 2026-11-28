/**
 * The ONE definition of an "open" (active) goal, shared by the Leader's
 * evidence, the Leader's `active-goals` metric, and the digest / dashboard
 * "goals in flight" list.
 *
 * WHY THIS FILE EXISTS (3.14 Leader reliability). The Leader counted open
 * goals from `listGoalsDetailed()` and replaced the WHOLE goals section with
 * `null` whenever the read was incomplete — while the digest counted from
 * `listGoals()`, which silently drops unreadable files. Three goal files had
 * a 1970 `updatedAt` (earlier than `createdAt`, which the store's record
 * guard rejects), so every read was "degraded": the digest reported 18–21
 * active goals while the Leader's model saw `GOALS AND FOCUS: null` and wrote
 * "the fleet has zero active goals". Now both sides count the same readable
 * goals with the same status rule, and an incomplete read is reported as a
 * LOWER BOUND with the unreadable-file count — never as nothing.
 *
 * Pure (no I/O): callers pass the result of a goal-store read.
 */
import type { Goal, RunBudget } from '../types.js';

// ---------------------------------------------------------------------------
// Shared pure goal constants, guards, and normalization helpers
// ---------------------------------------------------------------------------

const GOAL_ID_PATTERN = /^[\w.-]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const GOAL_MAX_LIST = 200;
export const GOAL_MAX_DIRECTORY_ENTRIES = 512;
export const GOAL_MAX_FILE_BYTES = 256 * 1024;
export const GOAL_LOCK_WAIT_MS = 2_000;

/** Default bounded budget shared by goal advance and direct goal execution. */
export const DEFAULT_GOAL_RUN_BUDGET: Readonly<RunBudget> = {
  maxTokens: 200_000,
  maxSteps: 40,
  allowCloud: false,
};

export function isGoalRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidGoalId(value: unknown): value is string {
  return typeof value === 'string' && GOAL_ID_PATTERN.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function parseIsoTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isValidIsoTimestamp(value: unknown): value is string {
  return parseIsoTimeMs(value) !== null;
}

export function goalIdIdentity(id: string): string {
  // Win32 resolves goal paths case-insensitively; other platforms retain the
  // exact persisted spelling so distinct case-sensitive records stay distinct.
  return process.platform === 'win32' ? id.toLowerCase() : id;
}

export function goalIdsMatch(left: string, right: string): boolean {
  return goalIdIdentity(left) === goalIdIdentity(right);
}

/** Lowercase, hyphenated, alphanumeric slug (shared by goal ids and milestone ids). */
export function slugifyGoalText(text: string, maxLength = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '');
}

export function formatGoalError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isOpenGoal(goal: Pick<Goal, 'status'>): boolean {
  return goal.status === 'active' || goal.status === 'planning';
}

export interface GoalReadLike {
  goals: readonly Goal[];
  /** False when any goal file could not be read (or the listing was truncated). */
  complete: boolean;
  /** Goal files that could not be read; undefined = not reported by the source. */
  unreadable?: number;
}

export interface OpenGoalsSummary {
  /** Open goals among the READABLE ones — a lower bound when `complete` is false. */
  open: number;
  active: number;
  planning: number;
  paused: number;
  /** Readable goals of every status. */
  total: number;
  complete: boolean;
  /** Goal files the store could not read (0 when complete; null = unknown). */
  unreadable: number | null;
  /** The open goals themselves, in the source's order. */
  openGoals: Goal[];
}

export function summarizeOpenGoals(read: GoalReadLike): OpenGoalsSummary {
  const openGoals = read.goals.filter(isOpenGoal);
  let active = 0;
  let planning = 0;
  let paused = 0;
  for (const g of read.goals) {
    if (g.status === 'active') active += 1;
    else if (g.status === 'planning') planning += 1;
    else if (g.status === 'paused') paused += 1;
  }
  return {
    open: openGoals.length,
    active,
    planning,
    paused,
    total: read.goals.length,
    complete: read.complete,
    unreadable: read.complete ? 0 : (typeof read.unreadable === 'number' ? read.unreadable : null),
    openGoals,
  };
}
