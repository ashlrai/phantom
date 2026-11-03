/**
 * Queue tier vocabulary for every router-queue line writer.
 *
 * dispatchd (contrib/mac/dispatchd.py, pinned) silently skips any line whose
 * tier is not in its TIERS set, so a bad tier never fails loudly: the job just
 * waits forever. Writers and linters therefore reject unknown tiers when the
 * line is produced. Keep QUEUE_TIERS identical to dispatchd's TIERS.
 */

export const QUEUE_TIERS = ['frontier', 'work', 'mid', 'fast'] as const;
export type QueueTier = (typeof QUEUE_TIERS)[number];

/**
 * Names operators reach for that map to a real tier. Used only to phrase the
 * rejection; an alias is never accepted as a tier.
 */
const TIER_ALIASES: Readonly<Record<string, QueueTier>> = {
  standard: 'work',
  normal: 'work',
  default: 'work',
  medium: 'mid',
  low: 'fast',
  high: 'frontier',
};
/** Edit distance within which a non-alias value still earns a suggestion. */
const MAX_SUGGESTION_DISTANCE = 2;
/** Rejected values are echoed in errors; cap them so task text cannot flood a log. */
const ECHO_CHARS = 40;

export function isQueueTier(value: string): value is QueueTier {
  return (QUEUE_TIERS as readonly string[]).includes(value);
}

/** Classic Levenshtein distance; inputs are short tier-sized strings. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_v, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** The tier a rejected value most likely meant, or undefined when none is near. */
export function closestQueueTier(value: string): QueueTier | undefined {
  const lower = value.toLowerCase();
  const alias = Object.hasOwn(TIER_ALIASES, lower) ? TIER_ALIASES[lower] : undefined;
  if (alias !== undefined) return alias;
  let best: QueueTier | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const tier of QUEUE_TIERS) {
    const distance = editDistance(lower, tier);
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

/** Operator-facing reason a tier is refused, or null when the tier is allowed. */
export function queueTierProblem(value: string): string | null {
  if (isQueueTier(value)) return null;
  const echoed = value.slice(0, ECHO_CHARS);
  const closest = closestQueueTier(value);
  const hint = closest === undefined ? '' : `; did you mean "${closest}"?`;
  return `unknown tier "${echoed}" (allowed: ${QUEUE_TIERS.join(', ')})${hint}`;
}

/** Returns the tier, or throws naming the allowed values and the closest match. */
export function assertQueueTier(value: string): QueueTier {
  const problem = queueTierProblem(value);
  if (problem !== null) throw new Error(`invalid queue line: ${problem}`);
  return value as QueueTier;
}
