/**
 * Unit U1 — planHarnessRefresh staleness from checkedAt.
 *
 * Exercises one stale entry (old checkedAt) and one fresh entry
 * (recent checkedAt) to ensure the local helper derives staleness
 * correctly without referencing a stale field on the source type.
 */
import { describe, expect, it } from 'vitest';
import { planHarnessRefresh } from '../src/core/learn/harness-refresh-plan.js';

describe('planHarnessRefresh — stale and fresh entries', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const staleDate = '2026-10-20'; // 12 days before now → stale (default 7-day window)
  const freshDate = '2026-10-31'; // 1 day before now → fresh

  it('places an old checkedAt source into the stale queue', () => {
    const digest = {
      v: 1,
      sources: [
        { id: 'S1', title: 'Stale Entry', checkedAt: staleDate, urls: ['https://example.test/stale'] },
      ],
      issues: [],
    };
    const result = planHarnessRefresh(digest, 10, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('S1');
    expect(result[0]!.reason).toBe('stale');
  });

  it('omits a recent checkedAt source (fresh)', () => {
    const digest = {
      v: 1,
      sources: [
        { id: 'S2', title: 'Fresh Entry', checkedAt: freshDate, urls: ['https://example.test/fresh'] },
      ],
      issues: [],
    };
    const result = planHarnessRefresh(digest, 10, now);
    expect(result).toHaveLength(0);
  });

  it('combines stale and fresh — only stale appears', () => {
    const digest = {
      v: 1,
      sources: [
        { id: 'S1', title: 'Stale Entry', checkedAt: staleDate, urls: ['https://example.test/stale'] },
        { id: 'S2', title: 'Fresh Entry', checkedAt: freshDate, urls: ['https://example.test/fresh'] },
      ],
      issues: [],
    };
    const result = planHarnessRefresh(digest, 10, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('S1');
    expect(result[0]!.reason).toBe('stale');
  });

  it('handles entries with null checkedAt (no issue → skip)', () => {
    const digest = {
      v: 1,
      sources: [
        { id: 'S3', title: 'No Date', checkedAt: null, urls: ['https://example.test/nodate'] },
      ],
      issues: [],
    };
    const result = planHarnessRefresh(digest, 10, now);
    expect(result).toHaveLength(0);
  });
});
