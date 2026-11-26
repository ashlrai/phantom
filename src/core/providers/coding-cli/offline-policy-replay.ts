/**
 * Offline inverse-propensity (IPS) and doubly robust (DR) replay over supplied
 * logged rows and caller-supplied candidate predictions.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts  ReplayRow         -> OfflineReplayRow (structural; identities caller-supplied)
 *   scheduler/learn.ts  policyChoice()    -> chooseCandidate() (argmax over supplied predictions)
 *   scheduler/learn.ts  evaluatePolicy()  -> scoreOfflinePolicy()
 *   scheduler/learn.ts  inline 1e-3 floor -> SOURCE_PROPENSITY_FLOOR, passed explicitly
 *
 * Pure: no I/O, clock, randomness, routing, provider defaults or promotion.
 * A score says how a supplied prediction table would have fared on recorded
 * rows. It is not evidence of superiority, deployment safety or live behavior.
 *
 * Deliberate divergences from the source:
 *   - Predictions are supplied per row and per candidate. The source derived
 *     them from a bandit state through expectedValue(); that state and its
 *     formula are not recovered here.
 *   - Empty evidence returns `null` scores. The source returned 0, which reads
 *     as a measured value.
 *   - The propensity floor is a required input. The source hard-coded 1e-3.
 *   - Ties: the source compared pairwise against a running best, so chains of
 *     values each within 1e-9 of the next could depend on order. Here the
 *     winner is the smallest tie key among candidates within 1e-9 of the row
 *     maximum, which is order-independent. The tie key is the source's
 *     `${poolId}:${consumer ?? ''}`.
 *   - Invalid input throws. The source would propagate NaN.
 *   - Logged identities and predictions must match the eligible set exactly.
 *     The source trusted its callers.
 *   - Rows may not share a rowId, because predictions are keyed by it.
 */

import {
  isFiniteNumber,
  requireNullableNulFreeIdentifier as consumerOf,
  requireNulFreeIdentifier as identifier,
} from './validation.js';

/** The source's inline floor on propensity in the importance weight. Documented, never implied. */
export const SOURCE_PROPENSITY_FLOOR = 1e-3;

/** The source policyChoice() tie band. */
const TIE_EPSILON = 1e-9;

const NUL = '\u0000';

/** One eligible identity. Pool and consumer are caller-supplied; none is embedded here. */
export interface OfflineReplayCandidate {
  readonly poolId: string;
  /** null for a pool with no consumer. Otherwise a non-empty identifier. */
  readonly consumer: string | null;
}

/** One recorded decision. Propensity is the logging policy's probability of the logged candidate. */
export interface OfflineReplayRow {
  readonly rowId: string;
  readonly loggedPoolId: string;
  readonly loggedConsumer: string | null;
  /** Finite, in (0, 1]. Values below the floor are clipped to the floor. */
  readonly propensity: number;
  readonly reward: number;
  /** The logged candidate must appear here. Identities must be unique. */
  readonly eligible: readonly OfflineReplayCandidate[];
}

/**
 * A candidate policy as caller-supplied predictions. `predictions[rowId]` maps
 * `offlineCandidateKey(poolId, consumer)` to a predicted value. It must cover
 * exactly the eligible identities of that row, and it must cover exactly the rows
 * supplied. The function never estimates a prediction.
 */
export interface OfflineReplayPolicy {
  /** A label for the output only. */
  readonly id: string;
  readonly predictions: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface OfflineReplayInput {
  readonly rows: readonly OfflineReplayRow[];
  readonly policy: OfflineReplayPolicy;
  /** Required and explicit: a finite number in (0, 1]. */
  readonly propensityFloor: number;
}

/** Fixed. A replay establishes none of these. */
export interface OfflineReplayClaims {
  readonly policySuperiority: false;
  readonly promotion: false;
  readonly operationalDeployment: false;
}

export interface OfflineReplayScore {
  readonly policyId: string;
  /** Number of supplied rows. Zero is explicit missing evidence, not an improvement. */
  readonly rowCount: number;
  /** Rows where the policy's choice equals the logged candidate. */
  readonly matchedRows: number;
  /** Rows whose propensity was below the floor and was clipped to it. */
  readonly clippedRows: number;
  readonly propensityFloor: number;
  /** Mean IPS over rows. null when rowCount is 0. */
  readonly ips: number | null;
  /** Mean doubly robust value over rows. null when rowCount is 0. */
  readonly doublyRobust: number | null;
  readonly claims: OfflineReplayClaims;
  readonly limitations: readonly string[];
}

const CLAIMS: OfflineReplayClaims = {
  policySuperiority: false,
  promotion: false,
  operationalDeployment: false,
};

const LIMITATIONS: readonly string[] = [
  'Scores use only the supplied rows. Coverage and overlap are not diagnosed.',
  'Logged propensities are trusted as given. Weights are 1/max(propensity, floor).',
  'DR inherits any bias in the supplied predictions and never checks them.',
  'A zero-row input is missing evidence, not a measured result.',
];

/** Stable key for one candidate identity within a row's prediction table. */
export function offlineCandidateKey(poolId: string, consumer: string | null): string {
  return `${poolId}${NUL}${consumer ?? ''}`;
}

/**
 * Score one candidate policy on supplied rows.
 *
 * Each row's policy choice is the argmax of its supplied predictions over the
 * eligible set. A tie goes to the smallest `${poolId}:${consumer ?? ''}`. IPS
 * credits `reward / max(propensity, floor)` only when the choice equals the
 * logged candidate. DR adds the chosen prediction and the weighted residual of
 * the logged candidate. Both are averaged over all supplied rows.
 *
 * Throws on any malformed or inconsistent input. Never mutates its input.
 */
export function scoreOfflinePolicy(input: OfflineReplayInput): OfflineReplayScore {
  const policyId = identifier(input.policy.id, 'policy.id');
  const floor = unitInterval(input.propensityFloor, 'propensityFloor');
  const rows = validateRows(input.rows);
  const predictions = validatePredictions(input.policy.predictions, rows);

  if (rows.length === 0) {
    return {
      policyId,
      rowCount: 0,
      matchedRows: 0,
      clippedRows: 0,
      propensityFloor: floor,
      ips: null,
      doublyRobust: null,
      claims: CLAIMS,
      limitations: LIMITATIONS,
    };
  }

  let ips = 0;
  let doublyRobust = 0;
  let matchedRows = 0;
  let clippedRows = 0;
  for (const row of rows) {
    const table = predictions.get(row.rowId)!;
    const chosen = chooseCandidate(row.eligible.map((c) => ({ ...c, value: table.get(c.key)! })));
    const loggedValue = table.get(row.loggedKey)!;
    const match = chosen.key === row.loggedKey;
    if (match) matchedRows += 1;
    if (row.propensity < floor) clippedRows += 1;
    const weight = match ? 1 / Math.max(row.propensity, floor) : 0;
    ips += weight * row.reward;
    doublyRobust += chosen.value + weight * (row.reward - loggedValue);
  }

  return {
    policyId,
    rowCount: rows.length,
    matchedRows,
    clippedRows,
    propensityFloor: floor,
    ips: ips / rows.length,
    doublyRobust: doublyRobust / rows.length,
    claims: CLAIMS,
    limitations: LIMITATIONS,
  };
}

interface ValidRow {
  rowId: string;
  propensity: number;
  reward: number;
  loggedKey: string;
  eligible: ReadonlyArray<OfflineReplayCandidate & { key: string }>;
}

function validateRows(rows: readonly OfflineReplayRow[]): ValidRow[] {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const rowIds = new Set<string>();
  return rows.map((row, i): ValidRow => {
    const label = `rows[${i}]`;
    const rowId = identifier(row.rowId, `${label}.rowId`);
    if (rowIds.has(rowId)) throw new RangeError(`${label}.rowId duplicates an earlier row`);
    rowIds.add(rowId);

    const propensity = finite(row.propensity, `${label}.propensity`);
    if (propensity <= 0 || propensity > 1) throw new RangeError(`${label}.propensity must be in (0, 1]`);
    const reward = finite(row.reward, `${label}.reward`);

    if (!Array.isArray(row.eligible) || row.eligible.length === 0) {
      throw new RangeError(`${label}.eligible must be a non-empty array`);
    }
    const seen = new Set<string>();
    // Array.isArray narrows a readonly array to any[], so the callback types are explicit.
    const eligible = row.eligible.map((c: OfflineReplayCandidate, j: number) => {
      const poolId = identifier(c.poolId, `${label}.eligible[${j}].poolId`);
      const consumer = consumerOf(c.consumer, `${label}.eligible[${j}].consumer`);
      const key = offlineCandidateKey(poolId, consumer);
      if (seen.has(key)) throw new RangeError(`${label}.eligible[${j}] duplicates an earlier identity`);
      seen.add(key);
      return { poolId, consumer, key };
    });

    const loggedPoolId = identifier(row.loggedPoolId, `${label}.loggedPoolId`);
    const loggedConsumer = consumerOf(row.loggedConsumer, `${label}.loggedConsumer`);
    const loggedKey = offlineCandidateKey(loggedPoolId, loggedConsumer);
    if (!seen.has(loggedKey)) throw new RangeError(`${label} logged identity is not in its eligible set`);

    return { rowId, propensity, reward, loggedKey, eligible };
  });
}

/** Returns rowId -> (candidate key -> value). Requires exact coverage in both directions. */
function validatePredictions(
  predictions: OfflineReplayPolicy['predictions'],
  rows: readonly ValidRow[],
): Map<string, Map<string, number>> {
  if (predictions === null || typeof predictions !== 'object') throw new TypeError('policy.predictions must be an object');
  const rowIdCount = Object.keys(predictions).length;
  if (rowIdCount !== rows.length) {
    throw new RangeError(`policy.predictions covers ${rowIdCount} rows, expected ${rows.length}`);
  }
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!Object.hasOwn(predictions, row.rowId)) {
      throw new RangeError(`policy.predictions has no entry for row ${row.rowId}`);
    }
    const table = predictions[row.rowId]!;
    if (table === null || typeof table !== 'object') throw new TypeError(`policy.predictions[${row.rowId}] must be an object`);
    if (Object.keys(table).length !== row.eligible.length) {
      throw new RangeError(`policy.predictions[${row.rowId}] must cover exactly the eligible set`);
    }
    const values = new Map<string, number>();
    for (const candidate of row.eligible) {
      if (!Object.hasOwn(table, candidate.key)) {
        throw new RangeError(`policy.predictions[${row.rowId}] has no value for an eligible candidate`);
      }
      values.set(candidate.key, finite(table[candidate.key], `policy.predictions[${row.rowId}]`));
    }
    out.set(row.rowId, values);
  }
  return out;
}

/** Argmax with the source tie band. Ties go to the smallest source tie key. Order-independent. */
function chooseCandidate<T extends OfflineReplayCandidate & { value: number; key: string }>(candidates: readonly T[]): T {
  let max = -Infinity;
  for (const c of candidates) if (c.value > max) max = c.value;
  let winner: T | null = null;
  for (const c of candidates) {
    if (c.value < max - TIE_EPSILON) continue;
    if (winner === null || tieKey(c) < tieKey(winner)) winner = c;
  }
  return winner!;
}

function tieKey(c: OfflineReplayCandidate): string {
  return `${c.poolId}:${c.consumer ?? ''}`;
}

function finite(value: unknown, label: string): number {
  if (!isFiniteNumber(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

function unitInterval(value: unknown, label: string): number {
  const n = finite(value, label);
  if (n <= 0 || n > 1) throw new RangeError(`${label} must be in (0, 1]`);
  return n;
}
