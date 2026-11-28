import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRIVE_ORIGIN,
  isAppAction,
  isDriveTarget,
} from '../src/core/drive/apps.js';
import {
  asDriveRecord,
  isBoundedDriveCount,
  isDriveRecord,
  isNonNegativeSafeInt,
} from '../src/core/drive/pool-routing.js';
import { securityPinnedPath as queuegenSecurityPinnedPath } from '../src/core/drive/queuegen.js';
import {
  isPrSecurityPinned,
  normalizeTimestampMap,
  prRetryBudgetAllows,
  prShortTag,
  pruneAbsentPrefixKeys,
  pruneExpiredEntries,
  pruneOldestEntries,
  repoShortName,
  securityPinnedPath,
} from '../src/core/drive/refix-loop.js';
import { parseDriveInputs } from '../src/core/drive/routines.js';

describe('drive shared value guards', () => {
  it('narrows plain records and falls back to empty objects', () => {
    const obj = { ok: true };
    expect(isDriveRecord(obj)).toBe(true);
    expect(asDriveRecord(obj)).toBe(obj);
    for (const bad of [null, undefined, 'x', 1, true, []]) {
      expect(isDriveRecord(bad)).toBe(false);
      expect(asDriveRecord(bad)).toEqual({});
    }
  });

  it('validates non-negative safe integers and bounded drive counts', () => {
    expect(isNonNegativeSafeInt(0)).toBe(true);
    expect(isNonNegativeSafeInt(100_001)).toBe(true);
    expect(isBoundedDriveCount(0)).toBe(true);
    expect(isBoundedDriveCount(100_000)).toBe(true);
    expect(isBoundedDriveCount(100_001)).toBe(false);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(isNonNegativeSafeInt(bad)).toBe(false);
      expect(isBoundedDriveCount(bad)).toBe(false);
    }
  });
});

describe('drive shared PR-loop and durable-state helpers', () => {
  it('re-exports one canonical securityPinnedPath and fails closed on truncated listings', () => {
    expect(queuegenSecurityPinnedPath).toBe(securityPinnedPath);
    expect(repoShortName('ashlrai/phantom')).toBe('phantom');
    expect(repoShortName('phantom')).toBe('phantom');
    expect(prShortTag('ashlrai/phantom', 42)).toBe('phantom#42');
    expect(isPrSecurityPinned({ files: ['src/a.ts'], filesTruncated: false })).toBe(false);
    expect(isPrSecurityPinned({ files: ['src/a.ts'], filesTruncated: true })).toBe(true);
    expect(isPrSecurityPinned({ files: ['.github/workflows/ci.yml'], filesTruncated: false })).toBe(true);
  });

  it('normalizes timestamp maps tolerantly with optional non-negative constraint', () => {
    const raw = { a: 0, b: 10, neg: -5, float: 1.2, str: '10' };
    expect(normalizeTimestampMap(raw)).toEqual({ a: 0, b: 10, neg: -5 });
    expect(normalizeTimestampMap(raw, { nonNegative: true })).toEqual({ a: 0, b: 10 });
    expect(normalizeTimestampMap(['bad'])).toEqual({});
  });

  it('prunes oldest, expired, and absent-prefix entries accurately', () => {
    const oldest: Record<string, { at: number }> = { a: { at: 30 }, b: { at: 10 }, c: { at: 20 } };
    pruneOldestEntries(oldest, (e) => e.at, 2);
    expect(Object.keys(oldest).sort()).toEqual(['a', 'c']);

    const windowed: Record<string, number> = { fresh: 950, exact: 900, stale: 800 };
    pruneExpiredEntries(windowed, (at) => at, 1_000, 100);
    expect(windowed).toEqual({ fresh: 950 });

    const prefixed: Record<string, number> = { 'repo#1': 1, 'repo#2': 2, 'other#1': 3 };
    pruneAbsentPrefixKeys(prefixed, 'repo#', new Set(['repo#2']));
    expect(prefixed).toEqual({ 'repo#2': 2, 'other#1': 3 });
    expect(() => pruneAbsentPrefixKeys(undefined, 'repo#', new Set())).not.toThrow();
  });

  it('enforces rolling window cap and retry cooldown', () => {
    expect(prRetryBudgetAllows([{ at: 100 }], 250, 3, 100)).toBe(true);
    expect(prRetryBudgetAllows([{ at: 180 }], 250, 3, 100)).toBe(false);
    expect(prRetryBudgetAllows([{ at: 10 }, { at: 20 }, { at: 30 }], 1_000, 3, 100)).toBe(false);
  });
});

describe('drive target, action, and routine input guards', () => {
  it('validates targets, actions, and rejects non-record drive status payloads', () => {
    expect(DEFAULT_DRIVE_ORIGIN).toBe('http://127.0.0.1:7777');
    expect(isDriveTarget('phantom')).toBe(true);
    expect(isDriveTarget('unknown')).toBe(false);
    expect(isDriveTarget(undefined)).toBe(false);
    expect(isAppAction('send-prompt')).toBe(true);
    expect(isAppAction('delete')).toBe(false);
    expect(() => parseDriveInputs('[]', '')).toThrow('Invalid drive status snapshot');
  });
});
