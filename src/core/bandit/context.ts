/**
 * context.ts — lane context derivation and the hierarchical cell keys.
 *
 * The bandit keeps a Beta posterior per (context cell × lane). Cells exist at
 * four levels of generality, most specific first:
 *
 *   L0  size · repo · tier · pool     — the exact queue-line shape
 *   L1  size ·        tier · pool     — repo generalized (new repos borrow)
 *   L2              tier · pool       — a cold size bucket borrows too
 *   L3  (global)                      — every observation lands here
 *
 * An update writes ALL levels, so specific cells are never poorer than the
 * data allows and the global cell is a complete summary. Selection uses the
 * deepest level whose posterior for that lane has `minCellSamples`
 * observations — a lane with thin exact-context evidence competes on its
 * broader posterior rather than on the uninformative prior.
 *
 * Keys are joined on '' and every free-text component is first escaped for
 * that separator, so a repo literally named "a b" can never alias another
 * context's cell. Non-string input is rejected by contextOf's callers before
 * it reaches here; these helpers still normalize defensively.
 */
import {
  LANE_SIZE_BUCKETS,
  type BanditConfig,
  type LaneContext,
  type LaneSizeBucket,
} from './types.js';

const SEPARATOR = String.fromCharCode(10);

/** Escape the separator and the escape char itself inside a free-text field. */
function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Lowercase/trim a context label; a blank label becomes the explicit `none` atom. */
export function contextLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === '' ? 'none' : text;
}

/**
 * Bucket a line size against ascending edges. `sizeLines <= 0` or missing is
 * the middle bucket — an unknown size must not masquerade as the smallest
 * work. Extra or missing edges fall back to the defaults' four.
 */
export function sizeBucketOf(sizeLines: number | undefined, edges: readonly number[]): LaneSizeBucket {
  const cuts = edges.length === LANE_SIZE_BUCKETS.length - 1 && edges.every((e, i) =>
    Number.isFinite(e) && e > 0 && (i === 0 || e > edges[i - 1]!),
  ) ? edges : [150, 400, 1200, 3600];
  if (typeof sizeLines !== 'number' || !Number.isFinite(sizeLines) || sizeLines <= 0) return 'm';
  let index = 0;
  while (index < cuts.length && sizeLines > cuts[index]!) index++;
  return LANE_SIZE_BUCKETS[index]!;
}

/** Build a context from raw line fields. `pool` is the line's declared pool. */
export function laneContextOf(input: {
  sizeLines?: number;
  repo: string;
  tier: string;
  pool: string;
}, config: Pick<BanditConfig, 'sizeEdges'>): LaneContext {
  return {
    sizeBucket: sizeBucketOf(input.sizeLines, config.sizeEdges),
    repo: contextLabel(input.repo),
    tier: contextLabel(input.tier),
    pool: contextLabel(input.pool),
  };
}

/** The four cell keys for a context, most specific first (L0..L3). */
export function contextCellKeys(context: LaneContext): readonly string[] {
  const size = context.sizeBucket;
  const repo = escapeField(context.repo);
  const tier = escapeField(context.tier);
  const pool = escapeField(context.pool);
  return [
    `${size}${SEPARATOR}${repo}${SEPARATOR}${tier}${SEPARATOR}${pool}`,
    `${size}${SEPARATOR}*${SEPARATOR}${tier}${SEPARATOR}${pool}`,
    `*${SEPARATOR}*${SEPARATOR}${tier}${SEPARATOR}${pool}`,
    `*${SEPARATOR}*${SEPARATOR}*${SEPARATOR}*`,
  ];
}

/** Human-readable level names for decisions and reports. */
export const CONTEXT_LEVEL_NAMES = Object.freeze([
  'size+repo+tier+pool',
  'size+tier+pool',
  'tier+pool',
  'global',
] as const);
