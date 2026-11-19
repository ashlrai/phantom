import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canaryBucket,
  COHORT_PROVENANCE,
  hashSeed,
  replayCanaryCohort,
} from '../src/core/providers/coding-cli/cohort-replay.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) hashSeed() and canaryBucket().
// Every identifier and salt here is synthetic. Expected buckets were computed outside Node with
// `printf 'salt:job' | shasum -a 256`, reading the first 4 bytes as a big-endian integer, then % 100.

const SALT = 'synthetic-salt';
const JOB_1 = 'job-0001'; // sha256("synthetic-salt:job-0001") starts f2be4eef -> 19
const JOB_2 = 'job-0002'; // starts 686a240a -> 6
const JOB_3 = 'job-0003'; // starts 88914f6b -> 27
const JOB_4 = 'job-0004'; // starts 6e6b5b6a -> 14

describe('canaryBucket vectors (source semantics: sha256(`${salt}:${jobId}`) first uint32 % 100)', () => {
  it('matches externally computed SHA256 buckets', () => {
    expect(canaryBucket(JOB_1, SALT)).toBe(19);
    expect(canaryBucket(JOB_2, SALT)).toBe(6);
    expect(canaryBucket(JOB_3, SALT)).toBe(27);
    expect(canaryBucket(JOB_4, SALT)).toBe(14);
  });

  it('uses the salt:jobId separator, not jobId:salt', () => {
    // sha256("synthetic-salt:") starts cffa53ed -> 97; the empty-id case pins the separator position.
    expect(canaryBucket('', SALT)).toBe(97);
    const reversed = createHash('sha256').update(`${JOB_1}:${SALT}`).digest().readUInt32BE(0) % 100;
    expect(reversed).not.toBe(canaryBucket(JOB_1, SALT));
  });

  it('hashSeed reads the first four SHA256 bytes big-endian', () => {
    expect(hashSeed(`${SALT}:${JOB_1}`)).toBe(0xf2be4eef);
  });

  it('changes bucket when the salt changes', () => {
    expect(canaryBucket(JOB_1, 'other-salt')).toBe(5);
  });
});

describe('replayCanaryCohort', () => {
  it('excludes exact threshold: bucket 19 is not selected at 19 and is selected at 20', () => {
    const at19 = replayCanaryCohort([JOB_1], SALT, 19);
    expect(at19[0]?.selected).toBe(false);
    const at20 = replayCanaryCohort([JOB_1], SALT, 20);
    expect(at20[0]?.selected).toBe(true);
  });

  it('selects nothing at 0 percent and everything at 100 percent', () => {
    const ids = [JOB_1, JOB_2, JOB_3, JOB_4];
    expect(replayCanaryCohort(ids, SALT, 0).every((r) => !r.selected)).toBe(true);
    expect(replayCanaryCohort(ids, SALT, 100).every((r) => r.selected)).toBe(true);
  });

  it('is repeatable for the same inputs', () => {
    const ids = [JOB_1, JOB_2, JOB_3, JOB_4];
    expect(replayCanaryCohort(ids, SALT, 15)).toEqual(replayCanaryCohort(ids, SALT, 15));
  });

  it('preserves input order and duplicate records', () => {
    const out = replayCanaryCohort([JOB_3, JOB_1, JOB_3], SALT, 50);
    expect(out.map((r) => r.jobId)).toEqual([JOB_3, JOB_1, JOB_3]);
    expect(out.map((r) => r.bucket)).toEqual([27, 19, 27]);
    expect(out.map((r) => r.selected)).toEqual([true, true, true]);
  });

  it('returns an empty array for empty input', () => {
    expect(replayCanaryCohort([], SALT, 50)).toEqual([]);
  });

  it('labels every record as historical and offline only', () => {
    expect(COHORT_PROVENANCE).toBe('historical-offline-only');
    for (const record of replayCanaryCohort([JOB_1, JOB_2], SALT, 10)) {
      expect(record.provenance).toBe(COHORT_PROVENANCE);
    }
  });

  it('rejects invalid percentages', () => {
    for (const bad of [-1, 101, 50.5, Number.NaN, Number.POSITIVE_INFINITY, '50', null]) {
      expect(() => replayCanaryCohort([JOB_1], SALT, bad as unknown as number)).toThrow(RangeError);
    }
  });

  it('rejects non-string runtime input', () => {
    expect(() => replayCanaryCohort('job-0001' as unknown as string[], SALT, 50)).toThrow(TypeError);
    expect(() => replayCanaryCohort([42 as unknown as string], SALT, 50)).toThrow(TypeError);
    expect(() => replayCanaryCohort([null as unknown as string], SALT, 50)).toThrow(TypeError);
    expect(() => replayCanaryCohort([JOB_1], 7 as unknown as string, 50)).toThrow(TypeError);
    expect(() => canaryBucket(JOB_1, undefined as unknown as string)).toThrow(TypeError);
    // A sparse hole must fail the string check, not be silently skipped.
    const holey = [JOB_1, , JOB_2] as unknown as string[];
    expect(() => replayCanaryCohort(holey, SALT, 50)).toThrow(TypeError);
  });

  it('does not mutate supplied input', () => {
    const ids = Object.freeze([JOB_2, JOB_1, JOB_2]) as readonly string[];
    const before = JSON.stringify(ids);
    const out = replayCanaryCohort(ids, SALT, 30);
    expect(JSON.stringify(ids)).toBe(before);
    expect(ids).toHaveLength(3);
    expect(out).not.toBe(ids);
  });
});
