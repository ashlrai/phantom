/**
 * Offline, deterministic canary-cohort replay over supplied job IDs.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/learn.ts  hashSeed(text)           -> hashSeed(text)  (same SHA256 first-uint32 big-endian read)
 *   scheduler/learn.ts  canaryBucket(jobId, salt) -> canaryBucket(jobId, salt)
 *                       hashed text is `${salt}:${jobId}` (the source separator, unchanged)
 *   scheduler/learn.ts  canary = buckets below the configured percent -> replayCanaryCohort()
 *
 * Pure: no I/O, clock, randomness, environment, routing, provider defaults,
 * dispatch, persistence or promotion. Membership answers "which supplied
 * historical job IDs fall inside the cohort that this salt and percent would
 * have selected". It is an offline label, not an experiment, an assignment to
 * execution, or permission to route anything live. Callers must not treat
 * `selected` as eligibility.
 *
 * Deliberate divergences from the source:
 *   - Job IDs and salt are validated at runtime. The source trusted its callers.
 *   - cohortPercent must be a finite integer in [0, 100]. The source compared
 *     a bucket against any number, so fractional or NaN percents passed silently.
 *   - The result is a new array in input order, with duplicate IDs preserved.
 *     Nothing is deduplicated, sorted or written back to the input.
 */

import { createHash } from 'node:crypto';

/** Every record this module returns carries this label. It marks the evidence as historical and offline. */
export const COHORT_PROVENANCE = 'historical-offline-only' as const;

export interface CohortRecord {
  readonly jobId: string;
  /** Stable 0..99 bucket derived from `${salt}:${jobId}`. */
  readonly bucket: number;
  /** True when bucket < cohortPercent. Membership only, never execution or live eligibility. */
  readonly selected: boolean;
  readonly provenance: typeof COHORT_PROVENANCE;
}

/** Source hashSeed(): first four SHA256 bytes read as an unsigned big-endian integer. */
export function hashSeed(text: string): number {
  if (typeof text !== 'string') throw new TypeError('hashSeed: text must be a string');
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** Source canaryBucket(): stable 0..99 bucket for one job under one salt. */
export function canaryBucket(jobId: string, salt: string): number {
  if (typeof jobId !== 'string') throw new TypeError('canaryBucket: jobId must be a string');
  if (typeof salt !== 'string') throw new TypeError('canaryBucket: salt must be a string');
  return hashSeed(`${salt}:${jobId}`) % 100;
}

/**
 * Replays cohort membership for explicit job IDs.
 *
 * Returns one record per input ID, in input order, including duplicates.
 * cohortPercent 0 selects nothing; 100 selects everything.
 */
export function replayCanaryCohort(
  jobIds: readonly string[],
  salt: string,
  cohortPercent: number,
): CohortRecord[] {
  if (!Array.isArray(jobIds)) throw new TypeError('replayCanaryCohort: jobIds must be an array');
  if (typeof salt !== 'string') throw new TypeError('replayCanaryCohort: salt must be a string');
  if (!Number.isInteger(cohortPercent) || cohortPercent < 0 || cohortPercent > 100) {
    throw new RangeError('replayCanaryCohort: cohortPercent must be an integer in [0, 100]');
  }
  // Array.from visits sparse holes as undefined, so a hole fails the string check instead of being skipped.
  return Array.from(jobIds, (jobId): CohortRecord => {
    const bucket = canaryBucket(jobId, salt);
    return { jobId, bucket, selected: bucket < cohortPercent, provenance: COHORT_PROVENANCE };
  });
}
