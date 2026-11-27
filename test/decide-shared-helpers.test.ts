import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TYPESAFE_DISABLE_ENV } from '../src/core/classify/typesafe-client.js';
import {
  DECISION_CACHE_MAX_ENTRIES,
  DECISION_CACHE_TTL_MS,
  setLruEntry,
  touchLruEntry,
} from '../src/core/decide/cache.js';
import { readChoiceAnswer, readNoulAnswer } from '../src/core/decide/decide.js';
import {
  classifierKilledByEnv,
  fallbackRateOf,
  isNonNegativeFinite,
  isPlainRecord,
  isValidCallBudget,
  isValidThreshold,
  meanOf,
} from '../src/core/decide/ledger.js';
import { jevStatus, jevStatusFromRecords } from '../src/core/decide/status.js';
import type { DecisionRecord } from '../src/core/decide/types.js';
import type { AshlrConfig } from '../src/core/types.js';

const tempHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('decide shared LRU cache helpers', () => {
  it('refreshes recency and evicts the least-recently-used entry past maxEntries', () => {
    expect(DECISION_CACHE_MAX_ENTRIES).toBe(1_000);
    expect(DECISION_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);

    const map = new Map<string, number>();
    setLruEntry(map, 'a', 1, 2);
    setLruEntry(map, 'b', 2, 2);
    touchLruEntry(map, 'a', 1);
    setLruEntry(map, 'c', 3, 2);
    expect([...map.entries()]).toEqual([['a', 1], ['c', 3]]);

    setLruEntry(map, 'a', 10, 2);
    expect([...map.entries()]).toEqual([['c', 3], ['a', 10]]);
  });
});

describe('decide shared validation, rollup, and kill-switch helpers', () => {
  it('validates plain records, finite non-negative numbers, thresholds and call budgets', () => {
    expect(isPlainRecord({ ok: true })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('x')).toBe(false);

    expect(isNonNegativeFinite(0)).toBe(true);
    expect(isNonNegativeFinite(1.25)).toBe(true);
    expect(isNonNegativeFinite(-0.01)).toBe(false);
    expect(isNonNegativeFinite(Number.NaN)).toBe(false);
    expect(isNonNegativeFinite(Number.POSITIVE_INFINITY)).toBe(false);

    expect(isValidThreshold(0.75)).toBe(true);
    expect(isValidThreshold(1)).toBe(true);
    expect(isValidThreshold(0)).toBe(false);
    expect(isValidThreshold(1.01)).toBe(false);
    expect(isValidThreshold('0.8')).toBe(false);

    expect(isValidCallBudget(null)).toBe(true);
    expect(isValidCallBudget(0)).toBe(true);
    expect(isValidCallBudget(1500)).toBe(true);
    expect(isValidCallBudget(-1)).toBe(false);
    expect(isValidCallBudget(1.5)).toBe(false);
    expect(isValidCallBudget('100')).toBe(false);
  });

  it('computes mean and fallback rate without inventing zeros for empty averages', () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([0.8, 1.0])).toBeCloseTo(0.9);
    expect(fallbackRateOf(0, 0)).toBe(0);
    expect(fallbackRateOf(4, 3)).toBe(0.25);
  });

  it('uses the shared classifier kill-switch env in both ledger and status', () => {
    const home = mkdtempSync(join(tmpdir(), 'decide-shared-'));
    tempHomes.push(home);
    vi.stubEnv('ASHLR_HOME', home);
    vi.stubEnv('ASHLR_JEV_DISABLE', '');
    vi.stubEnv(TYPESAFE_DISABLE_ENV, 'YES');

    expect(classifierKilledByEnv()).toBe(true);
    const status = jevStatus({ phantom: { enabled: false } } as unknown as AshlrConfig);
    expect(status.enabled).toBe(false);
    expect(status.keyed).toBe(false);
    expect(status.disabledBy).toBe(`${TYPESAFE_DISABLE_ENV} is set`);

    vi.stubEnv(TYPESAFE_DISABLE_ENV, '0');
    expect(classifierKilledByEnv()).toBe(false);
  });

  it('computes consistent coverage and per-kind rollups in jevStatusFromRecords', () => {
    const records: DecisionRecord[] = [
      {
        ts: '2026-11-05T10:00:00.000Z', kind: 'lane-choice', path: 'jev', confidence: 0.9,
        jevConfidence: 0.9, cached: false, called: true, inputTokens: 100, outputTokens: 10,
        estCostUsd: 0.001, durationMs: 40,
      },
      {
        ts: '2026-11-05T11:00:00.000Z', kind: 'lane-choice', path: 'fallback', reason: 'below-threshold',
        confidence: 1, jevConfidence: 0.5, cached: false, called: true, durationMs: 60,
      },
    ];
    const status = jevStatusFromRecords(records, {
      enabled: true, keyed: true, day: '2026-11-05', dailyCallBudget: 1500, disabledKinds: [],
    });
    expect(status.usageCoverage).toEqual({ reportedCalls: 1, unknownCalls: 1 });
    expect(status.costCoverage).toEqual({ pricedCalls: 1, unknownCalls: 1, source: 'recorded-estimates' });
    expect(status.avgConfidenceToday).toBeCloseTo(0.7);
    expect(status.avgLatencyMsToday).toBe(50);
    expect(status.fallbackRateToday).toBe(0.5);
    expect(status.byKind[0]).toMatchObject({
      kind: 'lane-choice',
      avgConfidence: 0.7,
      avgLatencyMs: 50,
      fallbackRate: 0.5,
      estCostUsd: null,
    });
  });
});

describe('decide shared answer readers', () => {
  it('reads allowed choice answers and rejects unknown choices or mismatched types', () => {
    const answers = {
      lane: { type: 'choice' as const, choice: 'cloud', confidence: 0.88, probabilities: { cloud: 0.88 } },
      work: { type: 'noul' as const, noul: 0.2 },
    };
    expect(readChoiceAnswer(answers, 'lane', ['fleet', 'cloud'] as const)).toEqual({ choice: 'cloud', confidence: 0.88 });
    expect(readChoiceAnswer(answers, 'lane', ['fleet'] as const)).toBeUndefined();
    expect(readChoiceAnswer(answers, 'work', ['fleet'] as const)).toBeUndefined();
    expect(readChoiceAnswer(answers, 'missing', ['fleet'] as const)).toBeUndefined();
  });

  it('reads noul answers with symmetric decisiveness around 0.5', () => {
    const answers = {
      yes: { type: 'noul' as const, noul: 0.85 },
      no: { type: 'noul' as const, noul: 0.15 },
      edge: { type: 'noul' as const, noul: 0.5 },
      other: { type: 'choice' as const, choice: 'a', confidence: 0.9, probabilities: { a: 0.9 } },
    };
    expect(readNoulAnswer(answers, 'yes')).toEqual({ yes: true, probability: 0.85, confidence: 0.85 });
    expect(readNoulAnswer(answers, 'no')).toEqual({ yes: false, probability: 0.15, confidence: 0.85 });
    expect(readNoulAnswer(answers, 'edge')).toEqual({ yes: true, probability: 0.5, confidence: 0.5 });
    expect(readNoulAnswer(answers, 'other')).toBeUndefined();
    expect(readNoulAnswer(answers, 'missing')).toBeUndefined();
  });
});
