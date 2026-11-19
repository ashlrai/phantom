import { describe, expect, it } from 'vitest';
import {
  buildRecordedModel,
  RECORDED_MODEL_PROVENANCE,
  RecordedModelError,
  type RecordedModelInput,
} from '../src/core/providers/coding-cli/recorded-model.js';

// Synthetic records only. Covers buildModel() recovered from PR #5952.
type Draft = { [K in keyof RecordedModelInput]: Array<NonNullable<RecordedModelInput[K]>[number]> };

const base = (): Draft => ({
  jobs: [
    { id: 'job-a', requireAssignment: false },
    { id: 'job-b', requireAssignment: false },
  ],
  pools: [
    { id: 'pool-x', concurrency: 2, inFlight: 1, quota: { state: 'known', remaining: 3 } },
    { id: 'pool-y', concurrency: 1, inFlight: 0, quota: { state: 'unknown' } },
  ],
  pairs: [
    { jobId: 'job-a', poolId: 'pool-x', consumer: null, coefficient: 1.5, demand: 1 },
    { jobId: 'job-a', poolId: 'pool-y', consumer: null, coefficient: 0.25, demand: 0.5 },
    { jobId: 'job-b', poolId: 'pool-x', consumer: 'cloud-agent', coefficient: 2, demand: 1.25 },
    { jobId: 'job-b', poolId: 'pool-y', consumer: null, coefficient: 0, demand: 1 },
  ],
  sharedLimits: [],
});

const lpOf = (input: Draft): string => buildRecordedModel(input).lp;

describe('buildRecordedModel (recovered from PR #5952)', () => {
  it('serializes a two-job, two-pool objective and constraints exactly', () => {
    const model = buildRecordedModel(base());
    expect(model.lp).toBe([
      'Maximize',
      ' obj: 1.500000 x_0_0_0 + 0.250000 x_0_1_0 + 2.000000 x_1_0_1',
      'Subject To',
      ' job_0: x_0_0_0 + x_0_1_0 <= 1',
      ' job_1: x_1_0_1 <= 1',
      ' cap_0: x_0_0_0 + x_1_0_1 <= 1.000000',
      ' quota_0: 1.000000 x_0_0_0 + 1.250000 x_1_0_1 <= 3.000000',
      ' cap_1: x_0_1_0 <= 1.000000',
      'Bounds',
      ' 0 <= x_0_0_0 <= 1',
      ' 0 <= x_0_1_0 <= 1',
      ' 0 <= x_1_0_1 <= 1',
      'Generals',
      ' x_0_0_0 x_0_1_0 x_1_0_1',
      'End',
      '',
    ].join('\n'));
    expect(model.constraintCount).toBe(5);
    expect(model.variables).toEqual([
      { name: 'x_0_0_0', jobId: 'job-a', poolId: 'pool-x', consumer: null, coefficient: 1.5, demand: 1 },
      { name: 'x_0_1_0', jobId: 'job-a', poolId: 'pool-y', consumer: null, coefficient: 0.25, demand: 0.5 },
      { name: 'x_1_0_1', jobId: 'job-b', poolId: 'pool-x', consumer: 'cloud-agent', coefficient: 2, demand: 1.25 },
    ]);
    expect(model.quotaUnknownPoolIds).toEqual(['pool-y']);
    expect(model.forcedJobIds).toEqual([]);
    expect(model.provenance).toEqual(RECORDED_MODEL_PROVENANCE);
    expect(model).toMatchObject({ grantsMergeAuthority: false, feasibilityAsserted: false });
  });

  it('subtracts in-flight work so exhausted concurrency gives a zero cap', () => {
    const input = base();
    input.pools[0] = { id: 'pool-x', concurrency: 1, inFlight: 1, quota: { state: 'unknown' } };
    const lp = lpOf(input);
    expect(lp).toContain(' cap_0: x_0_0_0 + x_1_0_1 <= 0.000000\n');
    expect(lp).not.toMatch(/quota_0/);
  });

  it('treats unknown quota as no row and known zero quota as a row that forces zero', () => {
    const unknownInput = base();
    unknownInput.pools[0] = { id: 'pool-x', concurrency: 2, inFlight: 0, quota: { state: 'unknown' } };
    const unknown = buildRecordedModel(unknownInput);
    expect(unknown.lp).not.toMatch(/quota_/);
    expect(unknown.quotaUnknownPoolIds).toEqual(['pool-x', 'pool-y']);

    const knownInput = base();
    knownInput.pools[0] = { id: 'pool-x', concurrency: 2, inFlight: 0, quota: { state: 'known', remaining: 0 } };
    const known = buildRecordedModel(knownInput);
    expect(known.lp).toContain(' quota_0: 1.000000 x_0_0_0 + 1.250000 x_1_0_1 <= 0.000000\n');
    expect(known.quotaUnknownPoolIds).toEqual(['pool-y']);
  });

  it('forces a required job with no eligible pair to an infeasible equality', () => {
    const input = base();
    input.jobs.push({ id: 'job-required', requireAssignment: true });
    input.pairs.push({ jobId: 'job-required', poolId: 'pool-y', consumer: null, coefficient: -1, demand: 1 });
    const model = buildRecordedModel(input);
    expect(model.forcedJobIds).toEqual(['job-required']);
    expect(model.lp).toContain(' force_2: d_2 = 1\n');
    expect(model.lp).toContain(' 0 <= d_2 <= 0\n');
    expect(model.lp).toMatch(/Generals\n x_0_0_0 x_0_1_0 x_1_0_1 d_2\n/);
  });

  it('uses an equality for a required job that has pairs', () => {
    const input = base();
    input.jobs[0] = { id: 'job-a', requireAssignment: true };
    expect(lpOf(input)).toContain(' job_0: x_0_0_0 + x_0_1_0 = 1\n');
  });

  it('applies shared total and per-consumer limits to the named pool only', () => {
    const input = base();
    input.sharedLimits = [{ poolId: 'pool-x', totalDemand: 2, consumerDemand: [{ consumer: 'cloud-agent', demand: 0.75 }] }];
    const lp = lpOf(input);
    expect(lp).toContain(' shared_0: 1.000000 x_0_0_0 + 1.250000 x_1_0_1 <= 2.000000\n');
    expect(lp).toContain(' shared_0_c0: 1.250000 x_1_0_1 <= 0.750000\n');

    const skipped = base();
    skipped.sharedLimits = [{ poolId: 'pool-y', totalDemand: 4, consumerDemand: [{ consumer: 'cloud-agent', demand: 1 }] }];
    const lpSkipped = lpOf(skipped);
    expect(lpSkipped).toContain(' shared_0: 0.500000 x_0_1_0 <= 4.000000\n');
    expect(lpSkipped).not.toMatch(/shared_0_c0/);
  });

  it('formats fractional demands to six decimals and is deterministic under pair reordering', () => {
    const input = base();
    input.pairs[0] = { jobId: 'job-a', poolId: 'pool-x', consumer: null, coefficient: 1, demand: 1 / 3 };
    const forward = buildRecordedModel(input);
    expect(forward.lp).toContain(' quota_0: 0.333333 x_0_0_0 + 1.250000 x_1_0_1 <= 3.000000\n');
    const again = buildRecordedModel({ ...input, pairs: [...input.pairs].reverse() });
    expect(again.lp).toBe(forward.lp);
    expect(again.variables).toEqual(forward.variables);
  });

  it('numbers named consumers by sorted identity after the no-consumer slot 0', () => {
    const model = buildRecordedModel({
      jobs: [{ id: 'j', requireAssignment: false }],
      pools: [{ id: 'p', concurrency: 2, inFlight: 0, quota: { state: 'unknown' } }],
      pairs: ['zeta', 'alpha', null].map((consumer) => ({ jobId: 'j', poolId: 'p', consumer, coefficient: 1, demand: 1 })),
    });
    expect(model.variables.map((v) => [v.name, v.consumer])).toEqual([
      ['x_0_0_0', null],
      ['x_0_0_1', 'alpha'],
      ['x_0_0_2', 'zeta'],
    ]);
  });

  it('serializes empty input as a noop with no variables', () => {
    const model = buildRecordedModel({ jobs: [], pools: [], pairs: [] });
    expect(model.lp).toBe(['Maximize', ' obj: 0', 'Subject To', ' noop: 0 <= 1', 'Bounds', 'End', ''].join('\n'));
    expect(model).toMatchObject({ variables: [], constraintCount: 0, quotaUnknownPoolIds: [], forcedJobIds: [] });
  });

  it('rejects nonfinite and out-of-range numbers, naming the field', () => {
    const cases: Array<[(i: Draft) => void, string]> = [
      [(i) => { i.pairs[0] = { ...i.pairs[0], coefficient: Number.NaN }; }, 'pairs[0].coefficient'],
      [(i) => { i.pairs[0] = { ...i.pairs[0], coefficient: Infinity }; }, 'pairs[0].coefficient'],
      [(i) => { i.pairs[0] = { ...i.pairs[0], demand: Number.NaN }; }, 'pairs[0].demand'],
      [(i) => { i.pairs[0] = { ...i.pairs[0], demand: -1 }; }, 'pairs[0].demand'],
      [(i) => { i.pools[0] = { ...i.pools[0], concurrency: Infinity }; }, 'pools[0].concurrency'],
      [(i) => { i.pools[0] = { ...i.pools[0], quota: { state: 'known', remaining: -1 } }; }, 'pools[0].quota.remaining'],
      [(i) => { i.pools[0] = { ...i.pools[0], quota: { state: 'maybe' } as never }; }, 'pools[0].quota.state'],
      [(i) => { i.sharedLimits = [{ poolId: 'pool-x', totalDemand: Number.NaN }]; }, 'sharedLimits[0].totalDemand'],
    ];
    for (const [mutate, field] of cases) {
      const input = base();
      mutate(input);
      expect(() => buildRecordedModel(input), field).toThrow(RecordedModelError);
      expect(() => buildRecordedModel(input), field).toThrow(field);
    }
  });

  it('rejects duplicate identities, dangling references and malformed containers', () => {
    const rejects = (mutate: (i: Draft) => void, pattern: RegExp) => {
      const input = base();
      mutate(input);
      expect(() => buildRecordedModel(input)).toThrow(pattern);
    };
    rejects((i) => i.jobs.push({ id: 'job-a', requireAssignment: false }), /duplicate job id/);
    rejects((i) => i.pools.push({ id: 'pool-x', concurrency: 1, inFlight: 0, quota: { state: 'unknown' } }), /duplicate pool id/);
    rejects((i) => i.pairs.push({ jobId: 'missing', poolId: 'pool-x', consumer: null, coefficient: 1, demand: 1 }), /unknown job/);
    rejects((i) => i.pairs.push({ jobId: 'job-a', poolId: 'missing', consumer: null, coefficient: 1, demand: 1 }), /unknown pool/);
    rejects((i) => i.pairs.push({ ...i.pairs[0], coefficient: 9 }), /duplicates/);
    rejects((i) => { i.sharedLimits = [{ poolId: 'missing', totalDemand: 1 }]; }, /unknown pool/);
    expect(() => buildRecordedModel({ jobs: 'x', pools: [], pairs: [] } as unknown as RecordedModelInput)).toThrow(/jobs must be an array/);
    expect(() => buildRecordedModel({ jobs: [{ id: '  ', requireAssignment: false }], pools: [], pairs: [] })).toThrow(/jobs\[0\]\.id/);
    expect(() => buildRecordedModel({ jobs: [null], pools: [], pairs: [] } as unknown as RecordedModelInput)).toThrow(/jobs\[0\] must be an object/);
  });

  it('keeps caller labels with newlines and punctuation out of the LP text', () => {
    const jobId = 'job\n force_0: x = 9; End';
    const poolId = 'pool"\nBounds -- ;';
    const consumer = 'cloud\nagent; Generals';
    const model = buildRecordedModel({
      jobs: [{ id: jobId, requireAssignment: true }],
      pools: [{ id: poolId, concurrency: 1, inFlight: 0, quota: { state: 'known', remaining: 1 } }],
      pairs: [{ jobId, poolId, consumer, coefficient: 1, demand: 1 }],
      sharedLimits: [{ poolId, totalDemand: 1, consumerDemand: [{ consumer, demand: 1 }] }],
    });
    for (const label of [jobId, poolId, consumer, 'cloud', 'agent', 'Generals;', 'Bounds --', ';', '"']) {
      expect(model.lp.includes(label), label).toBe(false);
    }
    expect(model.lp).toContain(' job_0: x_0_0_1 = 1\n');
    expect(model.lp).toContain(' shared_0_c0: 1.000000 x_0_0_1 <= 1.000000\n');
    expect(model.variables[0]).toMatchObject({ name: 'x_0_0_1', jobId, poolId, consumer });
  });

  it('never mutates its input', () => {
    const input = base();
    input.sharedLimits = [{ poolId: 'pool-x', totalDemand: 2, consumerDemand: [{ consumer: 'cloud-agent', demand: 1 }] }];
    const snapshot = JSON.parse(JSON.stringify(input)) as Draft;
    buildRecordedModel(input);
    expect(input).toEqual(snapshot);
  });
});
