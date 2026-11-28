/**
 * src/core/portfolio/scoring.ts — the single source of truth for WorkItem
 * priority scoring, WorkSource vocabulary, and pure validation guards shared
 * across src/core/portfolio/ and src/cli/backlog*.
 *
 * A pure leaf module with zero runtime imports (type-only import of WorkSource
 * is erased at compile time). Both scanners and backlog/queue modules share
 * these definitions without introducing cycles or growing authority closures.
 *
 * backlog.ts re-exports `scoreItem` and `sourceTierMultiplier` so existing
 * importers keep working.
 *
 * Pure and deterministic.
 */

import type { WorkSource } from '../types.js';

/** Canonical list of all WorkItem sources; stays in lockstep with WorkSource. */
export const WORK_SOURCES = [
  'issue',
  'todo',
  'test',
  'dep',
  'doc',
  'security',
  'plugin',
  'self',
  'lint',
  'goal',
  'hygiene',
  'invent',
] as const satisfies readonly WorkSource[];

const WORK_SOURCE_SET: ReadonlySet<string> = new Set(WORK_SOURCES);

/** Type guard for canonical WorkSource strings. */
export function isWorkSource(value: unknown): value is WorkSource {
  return typeof value === 'string' && WORK_SOURCE_SET.has(value);
}

/** True when `value` is a non-null, non-array object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** True when `value` is a lowercase 64-character hex SHA-256 digest string. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

/** Normalize Windows backslashes to POSIX forward slashes for path matching. */
export function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Priority score; higher = do first.
 * Heuristic: value / effort (both clamped to 1..5, so effort can never be 0
 * and the result is always finite and > 0).
 *
 * NOT rounded: callers that want a display value round at the edge. Rounding
 * here loses ordering information between items whose scores differ in the
 * third decimal.
 */
export function scoreItem(value: number, effort: number): number {
  const v = Math.max(1, Math.min(5, value));
  const e = Math.max(1, Math.min(5, effort));
  return v / e;
}

/**
 * Source priority tiers. Higher tier = more substantive work.
 *
 * Tier 3 (highest) — goal, issue: directive goals and tracked bugs drive real
 *   feature/fix work; the fleet should always prefer these.
 * Tier 2 (high)    — security, test: security vulnerabilities and failing tests
 *   are urgent and produce concrete diffs.
 * Tier 1 (normal)  — self, plugin, doc: useful but not fleet-critical.
 * Tier 0 (low)     — dep, lint, hygiene, todo: often noisy / low yield; should
 *   rank below substantive work when both are present.
 *
 * Multipliers are chosen so that a tier-3 item with value=2 outranks a tier-0
 * item with value=5 (2 * 1.8 = 3.6 > 5/5 * 0.6 = 0.6, even at effort=1).
 */
const SOURCE_TIER_MULTIPLIER: Record<string, number> = {
  goal:     1.8,
  issue:    1.8,
  security: 1.4,
  test:     1.4,
  self:     1.0,
  plugin:   1.0,
  doc:      1.0,
  todo:     0.6,
  dep:      0.6,
  lint:     0.6,
  hygiene:  0.6,
};

/** Returns the source-tier multiplier for an item's source. Unknown sources → 1.0. */
export function sourceTierMultiplier(source: string): number {
  return SOURCE_TIER_MULTIPLIER[source] ?? 1.0;
}
