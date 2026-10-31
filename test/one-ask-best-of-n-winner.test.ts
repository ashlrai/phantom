/**
 * ONE-ASK-FLOW (VISION-V4) best-of-N winner rule —
 * src/core/run/best-of-n-policy.ts.
 *
 * The rule: drop failing candidates, then rank the survivors by
 *   1. tests passed   2. smaller diff   3. verdict   4. fewest tokens
 *   5. index (deterministic)
 *
 * Every tiebreak level gets a table: each row is a two-candidate race that
 * isolates exactly one level, plus the eligibility table for the drop rule.
 * Pure module — no mocks, no HOME, no I/O.
 */
import { describe, expect, it } from 'vitest';

import {
  compareOneAskBestOfNCandidates,
  isOneAskBestOfNWinnerCandidate,
  selectOneAskBestOfNWinner,
  type OneAskBestOfNCandidate,
} from '../src/core/run/best-of-n-policy.js';

/** A healthy, fully-evidenced baseline; rows override one field at a time. */
const BASE: OneAskBestOfNCandidate = {
  index: 0,
  diff: 'diff --git a/x b/x\n+line',
  testsPassed: true,
  score: 12,
  tokens: 1_000,
};

const candidate = (over: Partial<OneAskBestOfNCandidate>): OneAskBestOfNCandidate => ({
  ...BASE,
  ...over,
});

/** Winner between two candidates, decided through the selector. */
const wins = (a: OneAskBestOfNCandidate, b: OneAskBestOfNCandidate): OneAskBestOfNCandidate | undefined =>
  selectOneAskBestOfNWinner([a, b]);

describe('one-ask best-of-N winner rule — drop failing candidates', () => {
  it.each([
    { name: 'terminal failure flag', over: { failed: true } },
    { name: 'producer/judge error evidence', over: { error: 'sandbox timed out' } },
    { name: 'verification ran and failed', over: { testsPassed: false } },
    { name: 'empty diff', over: { diff: '' } },
    { name: 'whitespace-only diff', over: { diff: '  \n\t ' } },
    { name: 'non-string diff', over: { diff: 42 as unknown as string } },
    { name: 'failure beats every other signal', over: { failed: true, testsPassed: true, score: 20, tokens: 1 } },
  ])('drops a candidate with $name', ({ over }) => {
    const failing = candidate(over as Partial<OneAskBestOfNCandidate>);
    expect(isOneAskBestOfNWinnerCandidate(failing)).toBe(false);
    // ...even when it is the only candidate, and even beside a healthy one.
    expect(selectOneAskBestOfNWinner([failing])).toBeUndefined();
    expect(wins(failing, candidate({ index: 1 }))).toMatchObject({ index: 1 });
  });

  it.each([
    { name: 'verified green suite', over: {} },
    { name: 'unverified but healthy', over: { testsPassed: undefined, score: undefined, tokens: undefined } },
    { name: 'blank error is not evidence', over: { error: '   ' } },
  ])('keeps a candidate with $name eligible', ({ over }) => {
    expect(isOneAskBestOfNWinnerCandidate(candidate(over as Partial<OneAskBestOfNCandidate>))).toBe(true);
  });

  it('refuses null, malformed and non-array input without throwing', () => {
    expect(isOneAskBestOfNWinnerCandidate(null as unknown as OneAskBestOfNCandidate)).toBe(false);
    expect(isOneAskBestOfNWinnerCandidate(undefined as unknown as OneAskBestOfNCandidate)).toBe(false);
    expect(isOneAskBestOfNWinnerCandidate('x' as unknown as OneAskBestOfNCandidate)).toBe(false);
    expect(selectOneAskBestOfNWinner([])).toBeUndefined();
    expect(selectOneAskBestOfNWinner([null, undefined] as unknown as OneAskBestOfNCandidate[])).toBeUndefined();
    expect(selectOneAskBestOfNWinner('nope' as unknown as OneAskBestOfNCandidate[])).toBeUndefined();
  });
});

describe('one-ask best-of-N winner rule — tiebreak levels', () => {
  it.each([
    { name: 'verified beats unverified despite a larger diff', a: { testsPassed: true, diff: 'x'.repeat(400) }, b: { testsPassed: undefined, diff: 'x' } },
    { name: 'verified beats unverified despite a worse verdict', a: { testsPassed: true, score: 4 }, b: { testsPassed: undefined, score: 20 } },
    { name: 'verified beats unverified despite more tokens', a: { testsPassed: true, tokens: 9_999 }, b: { testsPassed: undefined, tokens: 1 } },
  ])('level 1 tests passed: $name', ({ a, b }) => {
    expect(wins(candidate({ index: 0, ...a }), candidate({ index: 1, ...b }))).toMatchObject({ index: 0 });
    expect(compareOneAskBestOfNCandidates(candidate({ index: 0, ...a }), candidate({ index: 1, ...b }))).toBeLessThan(0);
  });

  it.each([
    { name: 'verified pair: smaller diff wins over higher verdict', a: { diff: 'x'.repeat(10), score: 4 }, b: { diff: 'x'.repeat(500), score: 20 } },
    { name: 'verified pair: smaller diff wins over fewer tokens', a: { diff: 'x'.repeat(10), tokens: 9_000 }, b: { diff: 'x'.repeat(500), tokens: 1 } },
    { name: 'unverified pair: smaller diff still decides', a: { testsPassed: undefined, diff: 'x'.repeat(10) }, b: { testsPassed: undefined, diff: 'x'.repeat(500) } },
    { name: 'one-char difference is enough', a: { diff: 'x'.repeat(11) }, b: { diff: 'x'.repeat(12) } },
  ])('level 2 smaller diff: $name', ({ a, b }) => {
    expect(wins(candidate({ index: 0, ...a }), candidate({ index: 1, ...b }))).toMatchObject({ index: 0 });
  });

  it.each([
    { name: 'higher verdict wins at equal diff size', a: { score: 18 }, b: { score: 9 } },
    { name: 'higher verdict wins over fewer tokens', a: { score: 18, tokens: 9_000 }, b: { score: 9, tokens: 1 } },
    { name: 'absent verdict scores 0 and loses', a: { score: 4 }, b: { score: undefined } },
    { name: 'NaN verdict scores 0 and loses', a: { score: 4 }, b: { score: Number.NaN } },
  ])('level 3 verdict: $name', ({ a, b }) => {
    expect(wins(candidate({ index: 0, diff: 'same-len', ...a }), candidate({ index: 1, diff: 'same-len', ...b }))).toMatchObject({ index: 0 });
  });

  it.each([
    { name: 'fewer tokens wins at full tie', a: { tokens: 100 }, b: { tokens: 800 } },
    { name: 'zero measured spend wins', a: { tokens: 0 }, b: { tokens: 1 } },
    { name: 'unmeasured loses to any measured spend', a: { tokens: 50_000 }, b: { tokens: undefined } },
    { name: 'NaN spend is unmeasured and loses', a: { tokens: 50_000 }, b: { tokens: Number.NaN } },
    { name: 'negative spend is unmeasured and loses', a: { tokens: 50_000 }, b: { tokens: -5 } },
    { name: 'infinite spend is unmeasured and loses', a: { tokens: 7 }, b: { tokens: Number.POSITIVE_INFINITY } },
  ])('level 4 fewest tokens: $name', ({ a, b }) => {
    expect(wins(candidate({ index: 0, diff: 'same-len', score: 10, ...a }), candidate({ index: 1, diff: 'same-len', score: 10, ...b }))).toMatchObject({ index: 0 });
  });

  it('level 5 index: identical candidates resolve to the lower fan-out index', () => {
    const first = candidate({ index: 2 });
    const second = candidate({ index: 7 });
    expect(wins(second, first)).toBe(first);
    expect(compareOneAskBestOfNCandidates(first, second)).toBeLessThan(0);
    expect(compareOneAskBestOfNCandidates(first, candidate({ index: 2 }))).toBe(0);
  });
});

describe('one-ask best-of-N winner rule — selection', () => {
  it('skips failing candidates mid-list and returns the surviving best', () => {
    const candidates = [
      candidate({ index: 0, failed: true, score: 20, tokens: 1 }),
      candidate({ index: 1, diff: 'x'.repeat(900), score: 20 }),   // bigger diff, best verdict
      candidate({ index: 2, diff: 'x'.repeat(50), score: 20 }),    // winner: smallest diff
      candidate({ index: 3, diff: 'x'.repeat(60), score: 20 }),
      candidate({ index: 4, testsPassed: false, diff: 'x' }),
    ];
    expect(selectOneAskBestOfNWinner(candidates)).toBe(candidates[2]);
  });

  it('is deterministic under input reorder', () => {
    const a = candidate({ index: 0, diff: 'x'.repeat(30) });
    const b = candidate({ index: 1, diff: 'x'.repeat(30), score: 8 });
    const c = candidate({ index: 2, diff: 'x'.repeat(20), score: 4 });
    // c wins on diff size alone; every permutation must agree.
    for (const order of [[a, b, c], [c, b, a], [b, a, c], [b, c, a]]) {
      expect(selectOneAskBestOfNWinner(order)).toBe(c);
    }
  });

  it('returns the candidate object itself, never a copy', () => {
    const only = candidate({ index: 0 });
    expect(selectOneAskBestOfNWinner([only])).toBe(only);
  });
});
