import { describe, expect, it } from 'vitest';

import {
  offlineCandidateKey,
  SOURCE_PROPENSITY_FLOOR,
  scoreOfflinePolicy,
  type OfflineReplayCandidate,
  type OfflineReplayInput,
  type OfflineReplayRow,
} from '../src/core/providers/coding-cli/offline-policy-replay.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) evaluatePolicy() and policyChoice().
// Every identifier and number here is synthetic.

const X: OfflineReplayCandidate = { poolId: 'synthetic-x', consumer: null };
const Y: OfflineReplayCandidate = { poolId: 'synthetic-y', consumer: null };

function row(
  rowId: string,
  logged: OfflineReplayCandidate,
  propensity: number,
  reward: number,
  eligible: readonly OfflineReplayCandidate[] = [X, Y],
): OfflineReplayRow {
  return { rowId, loggedPoolId: logged.poolId, loggedConsumer: logged.consumer, propensity, reward, eligible };
}

/** Predictions for one row, keyed by candidate identity. */
function preds(pairs: Array<[OfflineReplayCandidate, number]>): Record<string, number> {
  return Object.fromEntries(pairs.map(([c, v]) => [offlineCandidateKey(c.poolId, c.consumer), v]));
}

/** A mutable draft of the replay input, so invalid-case mutations type-check. */
interface Draft {
  rows: OfflineReplayRow[];
  policy: { id: string; predictions: Record<string, Record<string, number>> };
  propensityFloor: number;
}

function baseInput(): Draft {
  return {
    rows: [
      row('r1', X, 0.5, 1),
      row('r2', Y, 0.25, 0.4),
    ],
    policy: {
      id: 'synthetic-policy-p',
      predictions: {
        r1: preds([[X, 0.2], [Y, 0.8]]),
        r2: preds([[X, 0.3], [Y, 0.6]]),
      },
    },
    propensityFloor: SOURCE_PROPENSITY_FLOOR,
  };
}

describe('scoreOfflinePolicy hand-calculated values', () => {
  it('matches a hand calculation for a non-matching and a matching choice', () => {
    // r1: policy picks Y (0.8 > 0.2), logged X -> no IPS credit; DM term = 0.8.
    // r2: policy picks Y (0.6 > 0.3), logged Y -> weight 1/0.25 = 4; IPS = 4*0.4 = 1.6;
    //     DR term = 0.6 + 4*(0.4 - 0.6) = -0.2.
    // IPS = (0 + 1.6)/2 = 0.8. DR = (0.8 - 0.2)/2 = 0.3.
    const score = scoreOfflinePolicy(baseInput());
    expect(score.rowCount).toBe(2);
    expect(score.matchedRows).toBe(1);
    expect(score.clippedRows).toBe(0);
    expect(score.ips).toBeCloseTo(0.8, 12);
    expect(score.doublyRobust).toBeCloseTo(0.3, 12);
    expect(score.policyId).toBe('synthetic-policy-p');
  });

  it('credits a policy that matches the logged choice on every row', () => {
    // r1: policy picks X (0.9 > 0.1), logged X -> weight 2; IPS = 2*1 = 2; DR = 0.9 + 2*(1-0.9) = 1.1.
    // r2: policy picks X (0.7 > 0.2), logged Y -> no IPS credit; DR = 0.7.
    // IPS = 2/2 = 1.0. DR = (1.1 + 0.7)/2 = 0.9.
    const input: OfflineReplayInput = {
      ...baseInput(),
      policy: { id: 'synthetic-policy-x', predictions: { r1: preds([[X, 0.9], [Y, 0.1]]), r2: preds([[X, 0.7], [Y, 0.2]]) } },
    };
    const score = scoreOfflinePolicy(input);
    expect(score.matchedRows).toBe(1);
    expect(score.ips).toBeCloseTo(1.0, 12);
    expect(score.doublyRobust).toBeCloseTo(0.9, 12);
  });

  it('gives a matching row with a unit propensity its full reward', () => {
    const score = scoreOfflinePolicy({
      rows: [row('r1', X, 1, 0.75)],
      policy: { id: 'p', predictions: { r1: preds([[X, 0.6], [Y, 0.1]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.ips).toBeCloseTo(0.75, 12);
    // DR = 0.6 + 1*(0.75 - 0.6) = 0.75.
    expect(score.doublyRobust).toBeCloseTo(0.75, 12);
  });
});

describe('deterministic ties', () => {
  it('breaks an exact tie by the smallest poolId:consumer key', () => {
    const b: OfflineReplayCandidate = { poolId: 'synthetic-b', consumer: null };
    const a: OfflineReplayCandidate = { poolId: 'synthetic-a', consumer: null };
    // Logged b; the policy's chosen candidate is a (smaller key). Non-match, so IPS is 0.
    const score = scoreOfflinePolicy({
      rows: [row('r1', b, 0.5, 1, [b, a])],
      policy: { id: 'p', predictions: { r1: preds([[b, 0.5], [a, 0.5]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.matchedRows).toBe(0);
    expect(score.ips).toBe(0);
    // DR = chosen value 0.5 + 0.
    expect(score.doublyRobust).toBeCloseTo(0.5, 12);
  });

  it('orders a null consumer before a named consumer on the same pool', () => {
    const named: OfflineReplayCandidate = { poolId: 'synthetic-a', consumer: 'synthetic-c' };
    const bare: OfflineReplayCandidate = { poolId: 'synthetic-a', consumer: null };
    // 'synthetic-a:' < 'synthetic-a:synthetic-c', so the bare candidate wins the tie.
    const score = scoreOfflinePolicy({
      rows: [row('r1', named, 0.5, 1, [named, bare])],
      policy: { id: 'p', predictions: { r1: preds([[named, 0.4], [bare, 0.4]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.matchedRows).toBe(0);
  });

  it('treats values within 1e-9 as tied and values beyond it as ordered', () => {
    const a: OfflineReplayCandidate = { poolId: 'synthetic-a', consumer: null };
    const b: OfflineReplayCandidate = { poolId: 'synthetic-b', consumer: null };
    const within = scoreOfflinePolicy({
      rows: [row('r1', b, 0.5, 1, [a, b])],
      policy: { id: 'p', predictions: { r1: preds([[a, 0.5], [b, 0.5 + 5e-10]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    // a wins the tie by key, so logged b is not matched.
    expect(within.matchedRows).toBe(0);
    const beyond = scoreOfflinePolicy({
      rows: [row('r1', a, 0.5, 1, [a, b])],
      policy: { id: 'p', predictions: { r1: preds([[a, 0.5], [b, 0.5 + 2e-9]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    // b is strictly greater beyond the band, so it is chosen and logged a is not matched.
    expect(beyond.matchedRows).toBe(0);
    expect(beyond.doublyRobust).toBeCloseTo(0.5 + 2e-9, 12);
  });
});

describe('propensity floor', () => {
  it('clips a propensity below the floor to the floor and counts it', () => {
    // propensity 1e-4 -> weight 1/1e-3 = 1000, not 10000.
    // IPS = 1000*0.5 = 500. DR = 0.6 + 1000*(0.5 - 0.6) = -99.4.
    const score = scoreOfflinePolicy({
      rows: [row('r1', X, 1e-4, 0.5)],
      policy: { id: 'p', predictions: { r1: preds([[X, 0.6], [Y, 0.1]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.clippedRows).toBe(1);
    expect(score.ips).toBeCloseTo(500, 9);
    expect(score.doublyRobust).toBeCloseTo(-99.4, 9);
  });

  it('does not clip a propensity equal to the floor', () => {
    const score = scoreOfflinePolicy({
      rows: [row('r1', X, SOURCE_PROPENSITY_FLOOR, 0.5)],
      policy: { id: 'p', predictions: { r1: preds([[X, 0.6], [Y, 0.1]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.clippedRows).toBe(0);
    expect(score.ips).toBeCloseTo(500, 9);
  });

  it('applies the caller-supplied floor, not the source constant', () => {
    const score = scoreOfflinePolicy({
      rows: [row('r1', X, 0.01, 0.5)],
      policy: { id: 'p', predictions: { r1: preds([[X, 0.6], [Y, 0.1]]) } },
      propensityFloor: 0.1,
    });
    expect(score.clippedRows).toBe(1);
    expect(score.propensityFloor).toBe(0.1);
    // weight = 1/0.1 = 10, IPS = 10*0.5 = 5.
    expect(score.ips).toBeCloseTo(5, 12);
  });
});

describe('empty and missing evidence', () => {
  it('reports zero rows as null scores, not as a measured zero', () => {
    const score = scoreOfflinePolicy({
      rows: [],
      policy: { id: 'p', predictions: {} },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    });
    expect(score.rowCount).toBe(0);
    expect(score.matchedRows).toBe(0);
    expect(score.clippedRows).toBe(0);
    expect(score.ips).toBeNull();
    expect(score.doublyRobust).toBeNull();
    expect(score.claims).toEqual({ policySuperiority: false, promotion: false, operationalDeployment: false });
  });

  it('rejects predictions for rows that were not supplied', () => {
    expect(() => scoreOfflinePolicy({
      rows: [],
      policy: { id: 'p', predictions: { ghost: preds([[X, 0.1], [Y, 0.1]]) } },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    })).toThrow(RangeError);
  });

  it('does not treat inherited object keys as row predictions', () => {
    expect(() => scoreOfflinePolicy({
      rows: [row('toString', X, 0.5, 1)],
      policy: { id: 'p', predictions: {} },
      propensityFloor: SOURCE_PROPENSITY_FLOOR,
    })).toThrow(RangeError);
  });
});

describe('invalid evidence and predictions', () => {
  // Each case mutates a fresh valid draft in exactly one way.
  const r1 = (i: Draft) => i.rows[0]!;
  const cases: Array<[string, (i: Draft) => void]> = [
    ['zero propensity', (i) => { i.rows[0] = { ...r1(i), propensity: 0 }; }],
    ['negative propensity', (i) => { i.rows[0] = { ...r1(i), propensity: -0.1 }; }],
    ['propensity above one', (i) => { i.rows[0] = { ...r1(i), propensity: 1.5 }; }],
    ['NaN propensity', (i) => { i.rows[0] = { ...r1(i), propensity: NaN }; }],
    ['infinite propensity', (i) => { i.rows[0] = { ...r1(i), propensity: Infinity }; }],
    ['NaN reward', (i) => { i.rows[0] = { ...r1(i), reward: NaN }; }],
    ['infinite reward', (i) => { i.rows[0] = { ...r1(i), reward: -Infinity }; }],
    ['NaN prediction', (i) => { i.policy.predictions.r1 = preds([[X, NaN], [Y, 0.8]]); }],
    ['missing prediction for an eligible candidate', (i) => { i.policy.predictions.r1 = { [offlineCandidateKey(X.poolId, null)]: 0.2 }; }],
    ['extra prediction for a non-eligible candidate', (i) => { i.policy.predictions.r1 = preds([[X, 0.2], [Y, 0.8], [{ poolId: 'synthetic-z', consumer: null }, 0.9]]); }],
    ['missing row predictions', (i) => { delete i.policy.predictions.r2; }],
    ['prediction for an unsupplied row', (i) => { i.policy.predictions.ghost = preds([[X, 0.1], [Y, 0.1]]); }],
    ['duplicate eligible identity', (i) => { i.rows[0] = { ...r1(i), eligible: [X, X] }; }],
    ['logged identity not eligible', (i) => { i.rows[0] = { ...r1(i), loggedPoolId: 'synthetic-z' }; }],
    ['empty eligible set', (i) => { i.rows[0] = { ...r1(i), eligible: [] }; }],
    ['duplicate row id', (i) => { i.rows[1] = { ...i.rows[1]!, rowId: 'r1' }; }],
    ['empty pool id', (i) => { i.rows[0] = { ...r1(i), loggedPoolId: '' }; }],
    ['NUL in pool id', (i) => { i.rows[0] = { ...r1(i), loggedPoolId: 'synthetic\u0000x' }; }],
    ['empty consumer', (i) => { i.rows[0] = { ...r1(i), loggedConsumer: '' }; }],
    ['empty policy id', (i) => { i.policy.id = ''; }],
    ['zero floor', (i) => { i.propensityFloor = 0; }],
    ['floor above one', (i) => { i.propensityFloor = 1.5; }],
    ['NaN floor', (i) => { i.propensityFloor = NaN; }],
  ];
  for (const [name, mutate] of cases) {
    it(`rejects ${name}`, () => {
      const input = baseInput();
      mutate(input);
      expect(() => scoreOfflinePolicy(input)).toThrow();
    });
  }
});

describe('immutability and order independence', () => {
  it('does not mutate supplied rows or predictions', () => {
    const input = baseInput();
    const before = JSON.stringify(input);
    const frozen = deepFreeze(input);
    expect(() => scoreOfflinePolicy(frozen)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is reproducible across repeated calls', () => {
    expect(scoreOfflinePolicy(baseInput())).toEqual(scoreOfflinePolicy(baseInput()));
  });

  it('is independent of row, eligible, and prediction-key order within floating precision', () => {
    const base = scoreOfflinePolicy(baseInput());
    const input = baseInput();
    const reordered: OfflineReplayInput = {
      ...input,
      rows: [...input.rows].reverse().map((r) => ({ ...r, eligible: [...r.eligible].reverse() })),
      policy: {
        id: input.policy.id,
        predictions: Object.fromEntries(
          Object.entries(input.policy.predictions).reverse().map(([id, table]) => [id, Object.fromEntries(Object.entries(table).reverse())]),
        ),
      },
    };
    const score = scoreOfflinePolicy(reordered);
    expect(score.rowCount).toBe(base.rowCount);
    expect(score.matchedRows).toBe(base.matchedRows);
    expect(score.ips).toBeCloseTo(base.ips!, 12);
    expect(score.doublyRobust).toBeCloseTo(base.doublyRobust!, 12);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
