import { describe, expect, it } from 'vitest';

import {
  projectRecordedDecisions,
  RECORDED_DECISION_PROVENANCE,
  RecordedDecisionProjectionError,
  type RecordedDecisionAlternative,
  type RecordedDecisionJob,
  type RecordedDecisionProjectionInput,
} from '../src/core/providers/coding-cli/recorded-decision-projection.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) decisionsFrom()/decision().
// Plainly fake identities only. Expected values are hand-computed from the source rules.
const NOW_MS = 1_700_000_000_000;
const NOW_ISO = '2023-11-14T22:13:20.000Z';

const alt = (poolId: string, consumer: string | null, policyId: string, coefficient: number): RecordedDecisionAlternative =>
  ({ poolId, consumer, policyId, coefficient });

const job = (id: string, patch: Partial<RecordedDecisionJob> = {}): RecordedDecisionJob => ({
  id,
  jobType: 'coding',
  canary: false,
  eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1)],
  ...patch,
});

const input = (jobs: RecordedDecisionJob[], patch: Partial<RecordedDecisionProjectionInput> = {}): RecordedDecisionProjectionInput => ({
  jobs,
  defaultPolicyId: 'fake-policy-default',
  nowMs: NOW_MS,
  solver: 'highs',
  fallback: false,
  ...patch,
});

// Mixed ordered run: assigned with string consumer, unassigned with a default policy, assigned negative,
// unassigned with no eligible alternatives, and an unassigned job whose selection is absent (undefined).
const MIXED: RecordedDecisionJob[] = [
  job('fake-job-1', {
    eligible: [alt('fake-pool-a', null, 'fake-policy-x', 2), alt('fake-pool-b', 'fake-consumer-1', 'fake-policy-y', 0.7)],
    selected: { poolId: 'fake-pool-b', consumer: 'fake-consumer-1' },
  }),
  job('fake-job-2', { jobType: 'investigation', canary: true, eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1.25)], selected: null }),
  job('fake-job-3', {
    jobType: 'review',
    eligible: [alt('fake-pool-c', 'fake-consumer-2', 'fake-policy-z', -1)],
    selected: { poolId: 'fake-pool-c', consumer: 'fake-consumer-2' },
  }),
  job('fake-job-4', { eligible: [], selected: null }),
  job('fake-job-5', { jobType: 'test-fixing', eligible: [alt('fake-pool-a', null, 'fake-policy-x', 0.3333333)] }),
];

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

describe('projectRecordedDecisions provenance and authority', () => {
  it('pins the source PR, SHA and historical-offline basis on every result', () => {
    const out = projectRecordedDecisions(input([]));
    expect(out.provenance).toEqual({
      source: 'historical-offline',
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      basis: 'recorded-decision-rows',
    });
    expect(out.provenance).toBe(RECORDED_DECISION_PROVENANCE);
  });

  it('never grants merge authority and fixes propensity at 1', () => {
    const out = projectRecordedDecisions(input(MIXED));
    expect(out.grantsMergeAuthority).toBe(false);
    for (const d of out.decisions) {
      expect(d.grantsMergeAuthority).toBe(false);
      expect(d.propensity).toBe(1);
    }
  });
});

describe('projectRecordedDecisions assignment and ordering', () => {
  it('returns one decision per job in input order with assigned and unassigned ids', () => {
    const out = projectRecordedDecisions(input(MIXED, { solver: 'greedy', fallback: true }));
    expect(out.decisions.map((d) => d.jobId)).toEqual(['fake-job-1', 'fake-job-2', 'fake-job-3', 'fake-job-4', 'fake-job-5']);
    expect(out.assignedJobIds).toEqual(['fake-job-1', 'fake-job-3']);
    expect(out.unassignedJobIds).toEqual(['fake-job-2', 'fake-job-4', 'fake-job-5']);
    expect(out.decisions[0]).toEqual({
      ts: NOW_ISO,
      jobId: 'fake-job-1',
      jobType: 'coding',
      poolId: 'fake-pool-b',
      consumer: 'fake-consumer-1',
      policyId: 'fake-policy-y',
      canary: false,
      propensity: 1,
      solver: 'greedy',
      fallback: true,
      grantsMergeAuthority: false,
      netValue: 0.7,
      eligible: [
        { poolId: 'fake-pool-a', consumer: null },
        { poolId: 'fake-pool-b', consumer: 'fake-consumer-1' },
      ],
    });
    expect(out.decisions[1]).toMatchObject({ jobId: 'fake-job-2', jobType: 'investigation', canary: true, solver: 'greedy' });
    expect(out.decisions[3].eligible).toEqual([]);
  });

  it('sums selected coefficients only, in job order', () => {
    expect(projectRecordedDecisions(input(MIXED)).objective).toBe(-0.3);
  });
});

describe('projectRecordedDecisions policy and consumer attribution', () => {
  it('attributes the selected alternative policy over the default and the default over other alternatives', () => {
    const out = projectRecordedDecisions(input(MIXED));
    expect(out.decisions[0].policyId).toBe('fake-policy-y'); // selected alternative wins over first-listed policy-x
    expect(out.decisions[1].policyId).toBe('fake-policy-default'); // unassigned uses default
    expect(out.decisions[1].eligible).toEqual([{ poolId: 'fake-pool-a', consumer: null }]);
  });

  it('keeps consumer null for pool-only alternatives and a string for consumer-bearing ones', () => {
    const jobs = [
      job('fake-job-n', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1)], selected: { poolId: 'fake-pool-a', consumer: null } }),
      job('fake-job-s', { eligible: [alt('fake-pool-a', 'fake-consumer-9', 'fake-policy-x', 1)], selected: { poolId: 'fake-pool-a', consumer: 'fake-consumer-9' } }),
    ];
    const out = projectRecordedDecisions(input(jobs));
    expect(out.decisions.map((d) => d.consumer)).toEqual([null, 'fake-consumer-9']);
    expect(out.decisions.map((d) => d.poolId)).toEqual(['fake-pool-a', 'fake-pool-a']);
  });

  it('distinguishes a null consumer from a string consumer on the same pool', () => {
    const jobs = [
      job('fake-job-d', {
        eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1), alt('fake-pool-a', 'fake-consumer-9', 'fake-policy-w', 5)],
        selected: { poolId: 'fake-pool-a', consumer: 'fake-consumer-9' },
      }),
    ];
    const out = projectRecordedDecisions(input(jobs));
    expect(out.decisions[0]).toMatchObject({ consumer: 'fake-consumer-9', policyId: 'fake-policy-w', netValue: 5 });
  });

  it('derives the timestamp from nowMs without reading a clock', () => {
    expect(projectRecordedDecisions(input(MIXED)).decisions[0].ts).toBe(NOW_ISO);
  });
});

describe('projectRecordedDecisions objective rounding and empty input', () => {
  it('rounds the objective to six decimals using the source Math.round formula', () => {
    const jobs = [job('fake-job-r', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', 0.1234567)], selected: { poolId: 'fake-pool-a', consumer: null } })];
    expect(projectRecordedDecisions(input(jobs)).objective).toBe(0.123457);
    const tiny = [job('fake-job-t', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', 0.0000004)], selected: { poolId: 'fake-pool-a', consumer: null } })];
    expect(projectRecordedDecisions(input(tiny)).objective).toBe(0);
  });

  it('never reports a negative zero objective', () => {
    const jobs = [job('fake-job-z', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', -0.0000001)], selected: { poolId: 'fake-pool-a', consumer: null } })];
    expect(Object.is(projectRecordedDecisions(input(jobs)).objective, 0)).toBe(true);
  });

  it('returns an empty projection for empty input', () => {
    expect(projectRecordedDecisions(input([]))).toMatchObject({
      decisions: [],
      assignedJobIds: [],
      unassignedJobIds: [],
      objective: 0,
      grantsMergeAuthority: false,
    });
  });
});

describe('projectRecordedDecisions malformed and inconsistent input', () => {
  const bad: Array<[string, RecordedDecisionProjectionInput]> = [
    ['non-array jobs', input('nope' as unknown as RecordedDecisionJob[])],
    ['empty job id', input([job('')])],
    ['empty job type', input([job('fake-job-x', { jobType: '' })])],
    ['non-boolean canary', input([job('fake-job-x', { canary: 'yes' as unknown as boolean })])],
    ['non-array eligible', input([job('fake-job-x', { eligible: null as unknown as RecordedDecisionAlternative[] })])],
    ['NaN coefficient', input([job('fake-job-x', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', Number.NaN)] })])],
    ['infinite coefficient', input([job('fake-job-x', { eligible: [alt('fake-pool-a', null, 'fake-policy-x', Infinity)] })])],
    ['empty policy id on alternative', input([job('fake-job-x', { eligible: [alt('fake-pool-a', null, '', 1)] })])],
    ['empty pool id on alternative', input([job('fake-job-x', { eligible: [alt('', null, 'fake-policy-x', 1)] })])],
    ['empty string consumer', input([job('fake-job-x', { eligible: [alt('fake-pool-a', '', 'fake-policy-x', 1)] })])],
    ['selection naming no offered alternative', input([job('fake-job-x', { selected: { poolId: 'fake-pool-z', consumer: null } })])],
    ['selection with mismatched consumer', input([job('fake-job-x', { selected: { poolId: 'fake-pool-a', consumer: 'fake-consumer-1' } })])],
    ['empty selected pool id', input([job('fake-job-x', { selected: { poolId: '', consumer: null } })])],
    ['empty default policy', input([job('fake-job-x')], { defaultPolicyId: '' })],
    ['fractional nowMs', input([], { nowMs: 1.5 })],
    ['NaN nowMs', input([], { nowMs: Number.NaN })],
    ['nowMs outside Date range', input([], { nowMs: 8.64e15 + 1 })],
    ['unknown solver', input([], { solver: 'simplex' as unknown as 'highs' })],
    ['non-boolean fallback', input([], { fallback: 'no' as unknown as boolean })],
  ];

  it.each(bad)('rejects %s', (_label, value) => {
    expect(() => projectRecordedDecisions(value)).toThrow(RecordedDecisionProjectionError);
  });

  it('names the offending field in the error message', () => {
    expect(() => projectRecordedDecisions(input([job('fake-job-x', { jobType: '' })]))).toThrow(/jobs\[0\]\.jobType/);
  });

  it('rejects duplicate job ids instead of overwriting', () => {
    expect(() => projectRecordedDecisions(input([job('fake-job-d'), job('fake-job-d')]))).toThrow(/duplicate job id/);
  });

  it('rejects a job that lists the same pool and consumer twice', () => {
    const dup = job('fake-job-a', {
      eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1), alt('fake-pool-a', null, 'fake-policy-y', 2)],
    });
    expect(() => projectRecordedDecisions(input([dup]))).toThrow(/more than once/);
  });

  it('treats a null consumer and the string consumer as distinct alternatives', () => {
    const ok = job('fake-job-ok', {
      eligible: [alt('fake-pool-a', null, 'fake-policy-x', 1), alt('fake-pool-a', 'fake-consumer-9', 'fake-policy-x', 1)],
    });
    expect(() => projectRecordedDecisions(input([ok]))).not.toThrow();
  });
});

describe('projectRecordedDecisions immutability and determinism', () => {
  it('leaves frozen inputs unchanged and returns fresh output objects', () => {
    const frozen = deepFreeze(MIXED.map((j) => ({ ...j, eligible: j.eligible.map((a) => ({ ...a })) })));
    const before = JSON.stringify(frozen);
    const out = projectRecordedDecisions(input(frozen));
    expect(JSON.stringify(frozen)).toBe(before);
    expect(out.decisions[0].eligible).not.toBe(frozen[0].eligible);
    expect(out.assignedJobIds).not.toBe(out.unassignedJobIds);
  });

  it('isolates output from later mutation and from the next call', () => {
    const out = projectRecordedDecisions(input(MIXED));
    out.decisions[0].eligible.push({ poolId: 'fake-pool-q', consumer: null });
    out.assignedJobIds.length = 0;
    expect(projectRecordedDecisions(input(MIXED))).toEqual(projectRecordedDecisions(input(MIXED)));
    expect(projectRecordedDecisions(input(MIXED)).decisions[0].eligible).toHaveLength(2);
  });

  it('is deterministic across repeated calls', () => {
    const first = projectRecordedDecisions(input(MIXED));
    for (let i = 0; i < 3; i++) expect(projectRecordedDecisions(input(MIXED))).toEqual(first);
  });
});
