import { describe, expect, it } from 'vitest';
import { profileMemoryKernel, profilePreparedMemoryKernel, syntheticMemoryProfile } from '../src/core/local-eval/memory-performance.js';
import { validMemoryPackQuery, validMemorySnapshot } from '../src/core/memory/validate.js';

describe('bounded reproducible synthetic memory performance profile', () => {
  it.each([128, 1024])('profiles %s declared events, includes full framing, and preserves deterministic source bytes', count => {
    const input = syntheticMemoryProfile(20261014, count);
    expect(validMemorySnapshot(input.snapshot)).toBe(true); expect(validMemoryPackQuery(input.query)).toBe(true);
    const report = profileMemoryKernel(20261014, count, 2);
    expect(report.events).toBe(count); expect(report.repeats.count).toBe(2); expect(report.samplesMs).toHaveLength(2);
    expect(report.firstCallMs).toBeGreaterThanOrEqual(0); expect(report.packBytes).toBeLessThanOrEqual(6144);
    expect(report.selected + report.omitted).toBe(count); expect(report.authority).toBe(false);
    expect(profileMemoryKernel(20261014, count, 1).packDigest).toBe(report.packDigest);
  });
  it('changes the declared seed/history fingerprint while keeping fixed corpus size and bounded query', () => {
    expect(profileMemoryKernel(1, 128, 1).corpusDigest).not.toBe(profileMemoryKernel(2, 128, 1).corpusDigest);
    expect(syntheticMemoryProfile(20261014, 128)).toEqual(syntheticMemoryProfile(20261014, 128));
  });
  it('refuses oversized histories or repetition rather than invoking an unbounded profiling loop', () => {
    expect(() => syntheticMemoryProfile(1, 4097)).toThrow('bounds refused');
    expect(() => syntheticMemoryProfile(0, 128)).toThrow('bounds refused');
    expect(() => profileMemoryKernel(1, 128, 31)).toThrow('repetition bounds refused');
  });
  it.each([128, 1024])('pairs %s raw/prepared events with identical receipts and every alternating observation retained', count => {
    const raw = profileMemoryKernel(20261014, count, 1);
    const paired = profilePreparedMemoryKernel(20261014, count, 3);
    expect(paired.corpusDigest).toBe(raw.corpusDigest); expect(paired.preparationMs).toBeGreaterThanOrEqual(0);
    expect(paired.schedule).toBe('alternating-raw-first-prepared-first'); expect(paired.preparedSnapshotReused).toBe(true);
    const projected = paired.arms.map(({ arm: _arm, samplesMs: _samples, distribution: _distribution, ...evidence }) => evidence);
    expect(projected[0]).toEqual(projected[1]);
    for (const arm of paired.arms) {
      expect(arm.samplesMs).toHaveLength(3); expect(arm.distribution.count).toBe(3);
      expect(arm.packDigest).toBe(raw.packDigest); expect(arm.packBytes).toBe(raw.packBytes);
      expect(arm.selected + arm.omitted).toBe(count);
    }
  });
  it('bounds paired runs independently of the original raw profile', () => {
    expect(() => profilePreparedMemoryKernel(1, 128, 31)).toThrow('repetition bounds refused');
    expect(() => profilePreparedMemoryKernel(1, 4097, 1)).toThrow('bounds refused');
  });
});
