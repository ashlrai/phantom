import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  compareLex,
  hasNoControlChars,
  hasPlainDataKeys,
  isCanonicalIsoTimestamp,
  isDenseDataArray,
  isNonNegativeDecimal,
  isPlainDataObject,
  isProactiveSlug,
  isSha256Hex,
  isUniqueStringList,
} from '../src/core/proactive/validation.js';
import { createRevisionRecordCodec } from '../src/core/proactive/replay-watermark.js';
import {
  companionDigest,
  companionIdentityEqual,
  isCanceledBeforeIntent,
  isTerminalAttemptContact,
} from '../src/core/proactive/coordination-types.js';
import { hasEligibleRoutingCandidate, isQualifiedRoutingCandidate } from '../src/core/proactive/routing-lab-store.js';

describe('proactive validation helpers', () => {
  it('validates SHA-256 hex digests, canonical ISO timestamps, slugs, and control characters', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('a'.repeat(63))).toBe(false);
    expect(isSha256Hex(123)).toBe(false);

    expect(isCanonicalIsoTimestamp('2026-10-12T12:00:00.000Z')).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-10-12T12:00:00Z')).toBe(false);
    expect(isCanonicalIsoTimestamp('2026-10-12T12:00:00.000+00:00')).toBe(false);
    expect(isCanonicalIsoTimestamp('2026-10-12T12:00:00.000Z'.padEnd(40, ' '))).toBe(false);

    expect(isProactiveSlug('generic-alpha-2')).toBe(true);
    expect(isProactiveSlug('a'.repeat(64))).toBe(true);
    expect(isProactiveSlug('a'.repeat(65))).toBe(false);
    expect(isProactiveSlug('UpperCase')).toBe(false);
    expect(isProactiveSlug('-leading')).toBe(false);

    expect(hasNoControlChars('hello world 🚀')).toBe(true);
    expect(hasNoControlChars('line1\nline2')).toBe(false);
    expect(hasNoControlChars('line1\n\tline2\r', { allowMultiline: true })).toBe(true);
    expect(hasNoControlChars('c1\u0085char', { allowMultiline: true })).toBe(true);
    expect(hasNoControlChars('c1\u0085char', { allowMultiline: true, rejectC1: true })).toBe(false);
    expect(hasNoControlChars('nul\u0000byte')).toBe(false);
    expect(hasNoControlChars('nul\u0000byte', { allowMultiline: true })).toBe(false);
    expect(hasNoControlChars('del\u007fchar')).toBe(false);
    expect([compareLex('a', 'b'), compareLex('b', 'a'), compareLex('a', 'a')]).toEqual([-1, 1, 0]);
    expect([isNonNegativeDecimal('0'), isNonNegativeDecimal('12.345'), isNonNegativeDecimal('01'), isNonNegativeDecimal('-5'), isNonNegativeDecimal('1'.repeat(65))]).toEqual([true, true, false, false, false]);
    expect([isUniqueStringList(['a', 'b'], 3, isProactiveSlug), isUniqueStringList(['a', 'a'], 3, isProactiveSlug), isUniqueStringList(['a', 'b', 'c'], 2, isProactiveSlug), isUniqueStringList(['Bad'], 3, isProactiveSlug)]).toEqual([true, false, false, false]);
  });

  it('enforces plain data-only objects and exact keys without invoking getters', () => {
    let getterCalled = false;
    const withGetter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() { getterCalled = true; return 'boom'; },
    });
    const nullProto = Object.assign(Object.create(null), { a: 1 });
    const hidden = Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false });

    expect(isPlainDataObject({ a: 1 })).toBe(true);
    expect(isPlainDataObject(nullProto)).toBe(true);
    expect(isPlainDataObject(withGetter)).toBe(false);
    expect(getterCalled).toBe(false);
    expect(isPlainDataObject({ a: 1, [Symbol('k')]: 2 })).toBe(false);
    expect(isPlainDataObject([])).toBe(false);
    expect(isPlainDataObject(new Date())).toBe(false);
    expect(isPlainDataObject({ a: 1, b: 2 }, { maxKeys: 1 })).toBe(false);
    expect(isPlainDataObject(hidden)).toBe(true);
    expect(isPlainDataObject(hidden, { requireEnumerable: true })).toBe(false);

    expect(hasPlainDataKeys({ a: 1, b: 2 }, ['a'], ['b'])).toBe(true);
    expect(hasPlainDataKeys({ b: 2 }, ['a'], ['b'])).toBe(false);
    expect(hasPlainDataKeys({ a: 1, c: 3 }, ['a'], ['b'])).toBe(false);
    expect(hasPlainDataKeys(hidden, ['a'], ['b'], { requireEnumerable: true })).toBe(false);
  });

  it('enforces dense data-only arrays without invoking getters', () => {
    let getterCalled = false;
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, '0', {
      enumerable: true,
      get() { getterCalled = true; return 'boom'; },
    });
    const sparse: unknown[] = [];
    sparse[1] = 'x';
    class CustomArray extends Array<unknown> {}
    const custom = new CustomArray('a');

    expect(isDenseDataArray(['a', 'b'], 2)).toBe(true);
    expect(isDenseDataArray(['a', 'b'], 1)).toBe(false);
    expect(isDenseDataArray(sparse, 5)).toBe(false);
    expect(isDenseDataArray(Object.assign(['a'], { extra: 1 }), 5)).toBe(false);
    expect(isDenseDataArray(getterArray, 5)).toBe(false);
    expect(getterCalled).toBe(false);
    expect(isDenseDataArray(custom, 5)).toBe(true);
    expect(isDenseDataArray(custom, 5, { exactPrototype: true })).toBe(false);
  });

  it('serializes canonical JSON, compares nullable identities, and builds 16-digit revision codecs', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: [3, 2, 1] } }))
      .toBe('{"a":{"c":[3,2,1],"d":true},"b":1}');
    expect(companionDigest({ b: 1, a: 2 })).toBe(companionDigest({ a: 2, b: 1 }));

    expect(companionIdentityEqual(
      { provider: 'codex', accountId: 'acct-1', agentId: null },
      { provider: 'codex', accountId: 'acct-1', agentId: null },
    )).toBe(true);
    expect(companionIdentityEqual(
      { provider: 'codex', accountId: 'acct-1', agentId: null },
      { provider: 'codex', accountId: 'acct-1', agentId: 'agent-1' },
    )).toBe(false);

    const first = { revision: 1, digest: 'a'.repeat(64) };
    const second = { revision: 2, digest: 'b'.repeat(64) };
    const codec = createRevisionRecordCodec<typeof first>(value => value as typeof first);
    expect(codec.recordId(first)).toBe('1');
    expect(codec.recordFileName(first)).toBe('0000000000000001.json');
    expect(codec.isRecordFileName('0000000000000001.json')).toBe(true);
    expect(codec.isRecordFileName('1.json')).toBe(false);
    expect(codec.stageToken(first)).toBe(first.digest);
    expect(codec.equivalent(first, { ...first })).toBe(true);
    expect(codec.equivalent(first, second)).toBe(false);
    expect(codec.compare!(first, second)).toBeLessThan(0);
    expect(codec.serialize(first)).toBe(`${canonicalJson(first)}\n`);
  });

  it('classifies terminal/pre-intent companion contacts and eligible routing candidates', () => {
    expect([isTerminalAttemptContact('proved-unstarted'), isTerminalAttemptContact('cancel-confirmed'), isTerminalAttemptContact('accepted')]).toEqual([true, true, false]);
    expect(isCanceledBeforeIntent({ contact: 'not-contacted', handoffAt: null, cancelRequestedAt: '2026-10-12T12:00:00.000Z', providerRunId: null })).toBe(true);
    expect(isCanceledBeforeIntent({ contact: 'not-contacted', handoffAt: null, cancelRequestedAt: null, providerRunId: null })).toBe(false);
    expect(isCanceledBeforeIntent({ contact: 'intent', handoffAt: '2026-10-12T12:00:00.000Z', cancelRequestedAt: '2026-10-12T12:00:01.000Z', providerRunId: null })).toBe(false);
    expect([
      isQualifiedRoutingCandidate({ qualification: 'qualified-shadow-fixture', holds: [] }),
      isQualifiedRoutingCandidate({ qualification: 'held', holds: [] }),
      isQualifiedRoutingCandidate({ qualification: 'planning-candidate', holds: ['budget-unknown'] }),
    ]).toEqual([true, false, false]);
    const state = {
      evaluations: [{
        id: 'rl_1', requestId: 'req-1', kind: 'preview' as const, mode: 'shadow-readonly' as const, status: 'completed' as const,
        inputDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), policyId: 'companion-routing-lab-v1' as const, modelId: 'jev-1.13.0' as const,
        adapterMode: 'deterministic-only' as const, createdAt: '2026-10-12T12:00:00.000Z', completedAt: '2026-10-12T12:00:01.000Z',
        localDurationMs: 1, providerLatencyMs: null, executionAuthorized: false as const, notes: [],
        summary: { total: 1, evaluated: 1, expected: 0, passed: 0, failed: 0, coverage: 1 },
        cases: [{
          caseId: 'c1', taskDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), selectedResourceId: 'res-ok', path: 'deterministic' as const,
          fallbackReason: null, expectedResourceId: null, passed: null, notes: [], localDurationMs: 1, providerLatencyMs: null, executionAuthorized: false as const,
          candidates: [
            { resourceId: 'res-ok', label: 'ok', qualification: 'planning-candidate' as const, holds: [], matchedCapabilityIds: ['review'], sourceMode: 'shadow-readonly' as const, executionAuthorized: false as const },
            { resourceId: 'res-held', label: 'held', qualification: 'held' as const, holds: ['source-missing'], matchedCapabilityIds: [], sourceMode: 'shadow-readonly' as const, executionAuthorized: false as const },
          ],
        }],
      }],
    };
    expect([hasEligibleRoutingCandidate(state, 'rl_1', 'res-ok'), hasEligibleRoutingCandidate(state, 'rl_1', 'res-held'), hasEligibleRoutingCandidate(state, 'rl_missing', 'res-ok')]).toEqual([true, false, false]);
  });
});
