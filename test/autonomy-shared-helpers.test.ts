import { describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  AUTONOMY_RISK_ORDER,
  configuredAutoMergeMaxRisk,
  finiteNumberOrNull,
  hasExactKeys,
  isCanonicalIsoTimestamp,
  isFiniteNumber,
  strictPlainRecord,
} from '../src/core/autonomy/protected-pr-handoff.js';
import {
  allEvidenceGatesOk,
  areEvidenceTimestampsFresh,
  type AutonomyEvidencePack,
} from '../src/core/autonomy/evidence-pack.js';
import {
  attachSourceQuality,
  combineAutonomySourceState,
  coverageMetric,
  failedOutcomeRecordsRead,
  isDerivedWorkTrajectory,
  latestActivityTime,
  parseEventMs,
  pushToGroupMap,
  safeArray,
  safeValue,
} from '../src/core/autonomy/outcome-records.js';

describe('autonomy shared pure validation and policy helpers', () => {
  it('validates strict plain records and exact keys across arrays and sets', () => {
    expect(strictPlainRecord({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
    expect(strictPlainRecord(Object.assign(Object.create(null), { a: 1 }))).toEqual({ a: 1 });
    expect(strictPlainRecord(null)).toBeNull();
    expect(strictPlainRecord([])).toBeNull();
    expect(strictPlainRecord(new Date())).toBeNull();
    expect(strictPlainRecord({ get a() { return 1; } })).toBeNull();
    expect(strictPlainRecord({ [Symbol('k')]: 1 })).toBeNull();
    const hidden = {};
    Object.defineProperty(hidden, 'a', { value: 1, enumerable: false });
    expect(strictPlainRecord(hidden)).toBeNull();
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('boom'); },
    });
    expect(strictPlainRecord(hostileProxy)).toBeNull();

    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1, b: 2 }, new Set(['a', 'b']))).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 2 }, new Set(['a', 'b']))).toBe(false);
  });

  it('validates canonical ISO timestamps, finite numbers, and configured auto-merge max risk', () => {
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00.000Z')).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00Z')).toBe(false);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00.000Z', 10)).toBe(false);
    expect(isCanonicalIsoTimestamp('not-a-date')).toBe(false);

    expect(isFiniteNumber(42)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('42')).toBe(false);
    expect(finiteNumberOrNull(3.5)).toBe(3.5);
    expect(finiteNumberOrNull(Number.NaN)).toBeNull();
    expect(finiteNumberOrNull(undefined)).toBeNull();

    expect(AUTONOMY_RISK_ORDER).toEqual({ low: 0, medium: 1, high: 2 });
    expect(configuredAutoMergeMaxRisk({} as AshlrConfig)).toBe('low');
    expect(configuredAutoMergeMaxRisk({ foundry: { autoMerge: { maxRisk: 'medium' } } } as AshlrConfig)).toBe('medium');
    expect(configuredAutoMergeMaxRisk({ foundry: { autoMerge: { maxRisk: 'high' } } } as AshlrConfig)).toBe('high');
    expect(configuredAutoMergeMaxRisk({ foundry: { autoMerge: { maxRisk: 'other' as never } } } as AshlrConfig)).toBe('low');
  });

  it('evaluates evidence timestamp freshness and aggregate gate status consistently', () => {
    const nowMs = Date.parse('2026-11-26T12:00:00.000Z');
    expect(areEvidenceTimestampsFresh('2026-11-26T11:55:00.000Z', '2026-11-26T11:54:00.000Z', nowMs)).toBe(true);
    expect(areEvidenceTimestampsFresh('2026-11-26T10:00:00.000Z', '2026-11-26T11:55:00.000Z', nowMs)).toBe(false);
    expect(areEvidenceTimestampsFresh('2026-11-26T12:05:00.000Z', '2026-11-26T11:55:00.000Z', nowMs)).toBe(false);
    expect(areEvidenceTimestampsFresh('2026-11-26T11:50:00.000Z', '2026-11-26T11:55:00.000Z', nowMs)).toBe(false);
    expect(areEvidenceTimestampsFresh(undefined, '2026-11-26T11:55:00.000Z', nowMs)).toBe(false);

    const ok = { ok: true, detail: 'ok' };
    const baseGates: AutonomyEvidencePack['gates'] = {
      authority: ok,
      provenance: ok,
      verification: ok,
      risk: ok,
      scope: ok,
    };
    expect(allEvidenceGatesOk(baseGates)).toBe(true);
    expect(allEvidenceGatesOk({ ...baseGates, manager: { ok: false, detail: 'denied' } })).toBe(false);
  });
});

describe('autonomy shared record and source-quality helpers', () => {
  it('guards readers, parses timestamps, computes coverage, and groups map entries', () => {
    expect(safeArray(() => [1, 2])).toEqual([1, 2]);
    expect(safeArray(() => undefined)).toEqual([]);
    expect(safeArray(() => { throw new Error('fail'); })).toEqual([]);

    expect(safeValue(() => 'ok')).toBe('ok');
    expect(safeValue(() => null)).toBeUndefined();
    expect(safeValue(() => { throw new Error('fail'); })).toBeUndefined();

    expect(parseEventMs('2026-11-26T12:00:00.000Z')).toBe(Date.parse('2026-11-26T12:00:00.000Z'));
    expect(parseEventMs('bad')).toBeNull();
    expect(parseEventMs(undefined)).toBeNull();

    expect(latestActivityTime(['2026-11-26T10:00:00.000Z', '2026-11-26T11:00:00.000Z', undefined]))
      .toBe('2026-11-26T11:00:00.000Z');
    expect(latestActivityTime([undefined, 'bad'], 'fallback')).toBe('fallback');

    expect(isDerivedWorkTrajectory('work:item-1')).toBe(true);
    expect(isDerivedWorkTrajectory('run:123')).toBe(false);
    expect(isDerivedWorkTrajectory(undefined)).toBe(false);

    expect(coverageMetric(3, 4)).toEqual({ count: 3, rate: 0.75 });
    expect(coverageMetric(0, 0)).toEqual({ count: 0, rate: 0 });

    const grouped = new Map<string, number[]>();
    pushToGroupMap(grouped, 'p1', 1);
    pushToGroupMap(grouped, 'p1', 2);
    pushToGroupMap(grouped, '', 3);
    pushToGroupMap(grouped, undefined, 4);
    expect([...grouped.entries()]).toEqual([['p1', [1, 2]]]);
  });

  it('attaches non-enumerable sourceQuality, combines source states, and builds failed reads', () => {
    const original = ['a', 'b'];
    const tagged = attachSourceQuality(original, { sourceState: 'healthy' as const });
    expect(tagged).not.toBe(original);
    expect(tagged).toEqual(['a', 'b']);
    expect(tagged.sourceQuality).toEqual({ sourceState: 'healthy' });
    expect(Object.keys(tagged)).toEqual(['0', '1']);

    expect(combineAutonomySourceState([
      { sourceState: 'healthy', complete: true },
      { sourceState: 'healthy', complete: true },
    ])).toBe('healthy');
    expect(combineAutonomySourceState([
      { sourceState: 'healthy', complete: true },
      { sourceState: 'missing', complete: true },
    ])).toBe('missing');
    expect(combineAutonomySourceState([
      { sourceState: 'healthy', complete: false },
      { sourceState: 'missing', complete: true },
    ])).toBe('degraded');

    const failed = failedOutcomeRecordsRead();
    expect(failed.records).toEqual([]);
    expect(failed.sourceQuality.sourceState).toBe('degraded');
    expect(failed.sourceQuality.complete).toBe(false);
    expect(failed.sourceQuality.sources.proposals.unreadableFiles).toBe(1);
    expect(failed.sourceQuality.sources.decisions.unreadableFiles).toBe(1);
    expect(failed.sourceQuality.sources.evidence.unreadableFiles).toBe(1);
    expect(failed.sourceQuality.sources.postMerge.stopReasons).toEqual(['io-error']);
    expect(failed.sourceQuality.sources.postMerge.limitExceeded).toBe(false);
  });
});
