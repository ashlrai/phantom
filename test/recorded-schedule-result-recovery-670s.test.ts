import { describe, expect, it } from 'vitest';

import {
  assembleRecordedSchedule,
  RECORDED_SCHEDULE_RESULT_PROVENANCE,
  RecordedScheduleResultError,
  type RecordedScheduleInput,
  type RecordedScheduleJob,
  type RecordedScheduleVariableRow,
} from '../src/core/providers/coding-cli/recorded-schedule-result.js';
import { recordedGreedyAssignment } from '../src/core/providers/coding-cli/recorded-greedy-assignment.js';
import { normalizeRecordedSolverResult, type RecordedSolverResult } from '../src/core/providers/coding-cli/recorded-solver-result.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) schedule() and resultFrom().
// Plainly synthetic identities and numbers; expectations are hand-computed.
const NOW_MS = 1_700_000_000_000;
const NOW_ISO = '2023-11-14T22:13:20.000Z';
const outcomeOf = (recorded: RecordedSolverResult) => normalizeRecordedSolverResult(recorded, { elapsedMs: 40, budgetMs: 100 });
const optimalRecord = (values: Record<string, number>, objective: number): RecordedSolverResult => ({
  Status: 'Optimal',
  ObjectiveValue: objective,
  Columns: Object.fromEntries(Object.entries(values).map(([name, Primal]) => [name, { Primal }])),
});
const TIMEOUT = outcomeOf({ Status: 'Time limit reached' });

const JOBS: RecordedScheduleJob[] = [
  { id: 'fake-job-1', jobType: 'coding', canary: false },
  { id: 'fake-job-2', jobType: 'review', canary: true },
  { id: 'fake-job-3', jobType: 'coding', canary: false },
];
const row = (name: string, jobId: string, poolId: string, consumer: string | null, coefficient: number, policyId: string): RecordedScheduleVariableRow =>
  ({ name, jobId, poolId, consumer, coefficient, policyId });
// job-1 has a tie at 2; job-2 has two alternatives; job-3 has none.
const ROWS: RecordedScheduleVariableRow[] = [
  row('fake-v-1', 'fake-job-1', 'fake-pool-a', null, 2, 'fake-policy-x'),
  row('fake-v-2', 'fake-job-1', 'fake-pool-b', 'fake-consumer-1', 2, 'fake-policy-y'),
  row('fake-v-3', 'fake-job-2', 'fake-pool-a', null, 1.25, 'fake-policy-x'),
  row('fake-v-4', 'fake-job-2', 'fake-pool-c', null, 0.5, 'fake-policy-z'),
];

// pool-a has concurrency 1, so job-2 is deferred there and admitted to pool-c.
const GREEDY = recordedGreedyAssignment({
  rankedPoolIds: ['fake-pool-a', 'fake-pool-b', 'fake-pool-c'],
  pools: [
    { id: 'fake-pool-a', concurrency: 1, inFlight: 0, quota: { known: false } },
    { id: 'fake-pool-b', concurrency: 2, inFlight: 0, quota: { known: false } },
    { id: 'fake-pool-c', concurrency: 2, inFlight: 0, quota: { known: false } },
  ],
  jobs: [
    { id: 'fake-job-1', pairs: [
      { poolId: 'fake-pool-a', consumer: null, coefficient: 2, demand: 1 },
      { poolId: 'fake-pool-b', consumer: 'fake-consumer-1', coefficient: 2, demand: 1 },
    ] },
    { id: 'fake-job-2', pairs: [
      { poolId: 'fake-pool-a', consumer: null, coefficient: 1.25, demand: 1 },
      { poolId: 'fake-pool-c', consumer: null, coefficient: 0.5, demand: 1 },
    ] },
    { id: 'fake-job-3', pairs: [] },
  ],
}).assignments;

const run = (patch: Partial<RecordedScheduleInput> & Pick<RecordedScheduleInput, 'outcome'>) =>
  assembleRecordedSchedule({ jobs: JOBS, variables: ROWS, defaultPolicyId: 'fake-policy-default', nowMs: NOW_MS, ...patch });

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

describe('assembleRecordedSchedule: optimal', () => {
  it('selects primal alternatives at the 0.5 threshold and keeps objective separate from the computed total', () => {
    const result = run({ outcome: outcomeOf(optimalRecord({ 'fake-v-1': 0.49, 'fake-v-2': 0.5, 'fake-v-3': 1, 'fake-v-4': 0 }, 3.5)) });

    expect(result).toMatchObject({ status: 'optimal', solver: 'highs', fallbackReason: null, objective: 3.5, assignmentTotal: 3.25 });
    expect(result.assignedJobIds).toEqual(['fake-job-1', 'fake-job-2']);
    expect(result.unassignedJobIds).toEqual(['fake-job-3']);
    expect(result.decisions.map((d) => [d.jobId, d.poolId, d.consumer, d.policyId, d.netValue])).toEqual([
      ['fake-job-1', 'fake-pool-b', 'fake-consumer-1', 'fake-policy-y', 2],
      ['fake-job-2', 'fake-pool-a', null, 'fake-policy-x', 1.25],
      ['fake-job-3', null, null, 'fake-policy-default', null],
    ]);
    expect(result.decisions[0]).toMatchObject({ ts: NOW_ISO, solver: 'highs', fallback: false, propensity: 1, canary: false });
    expect(result.decisions[1]).toMatchObject({ canary: true, jobType: 'review' });
  });

  it('breaks ties on equal coefficients by the first recorded row', () => {
    const result = run({ outcome: outcomeOf(optimalRecord({ 'fake-v-1': 1, 'fake-v-2': 1, 'fake-v-3': 0, 'fake-v-4': 0 }, 2)) });
    expect(result.decisions[0]).toMatchObject({ poolId: 'fake-pool-a', netValue: 2 });
  });

  it('keeps explicit recorded zero objectives distinct from the computed total, including an all-zero run', () => {
    const selected = run({ outcome: outcomeOf(optimalRecord({ 'fake-v-1': 1 }, 0)) });
    expect(selected).toMatchObject({ objective: 0, assignmentTotal: 2, assignedJobIds: ['fake-job-1'] });
    const none = run({ outcome: outcomeOf(optimalRecord({ 'fake-v-1': 0, 'fake-v-2': 0 }, 0)) });
    expect(none).toMatchObject({ objective: 0, assignmentTotal: 0, assignedJobIds: [] });
    expect(none.unassignedJobIds).toEqual(['fake-job-1', 'fake-job-2', 'fake-job-3']);
  });
});

describe('assembleRecordedSchedule: infeasible', () => {
  it('produces no assignments and ignores tempting fallback evidence', () => {
    const result = run({ outcome: outcomeOf({ Status: 'Infeasible' }), fallbackSelections: GREEDY });
    expect(result).toMatchObject({ status: 'infeasible', solver: 'highs', fallbackReason: null, objective: null, assignmentTotal: 0 });
    expect(result.assignedJobIds).toEqual([]);
    expect(result.decisions.every((d) => d.poolId === null && d.fallback === false)).toBe(true);
  });
});

describe('assembleRecordedSchedule: timeout and failed fallback', () => {
  it('uses the recorded greedy selections for a timeout', () => {
    const result = run({ outcome: TIMEOUT, fallbackSelections: GREEDY });
    expect(result).toMatchObject({ status: 'fallback', solver: 'greedy', fallbackReason: 'timeout', objective: null, assignmentTotal: 2.5 });
    expect(result.decisions.map((d) => [d.jobId, d.poolId, d.fallback, d.solver])).toEqual([
      ['fake-job-1', 'fake-pool-a', true, 'greedy'],
      ['fake-job-2', 'fake-pool-c', true, 'greedy'],
      ['fake-job-3', null, true, 'greedy'],
    ]);
    expect(result.unassignedJobIds).toEqual(['fake-job-3']);
  });

  it('uses the recorded greedy selections for a failed solver', () => {
    const result = run({ outcome: outcomeOf({ Status: 'Unbounded' }), fallbackSelections: GREEDY });
    expect(result).toMatchObject({ status: 'fallback', fallbackReason: 'failed', assignmentTotal: 2.5 });
  });

  it('accepts explicit empty fallback evidence as nothing admitted', () => {
    const result = run({ outcome: TIMEOUT, fallbackSelections: [] });
    expect(result).toMatchObject({ fallbackReason: 'timeout', assignmentTotal: 0 });
    expect(result.unassignedJobIds).toEqual(['fake-job-1', 'fake-job-2', 'fake-job-3']);
  });

  it('rejects timeout or failed runs with no fallback evidence instead of inventing selections', () => {
    expect(() => run({ outcome: TIMEOUT })).toThrow(/requires recorded fallbackSelections/);
    expect(() => run({ outcome: outcomeOf({ Status: 'Unbounded' }) })).toThrow(/requires recorded fallbackSelections/);
  });
});

describe('assembleRecordedSchedule: rejected evidence', () => {
  const [g1, g2] = GREEDY as [(typeof GREEDY)[number], (typeof GREEDY)[number]];
  it.each([
    ['unoffered alternative', [{ ...g1, poolId: 'fake-pool-z' }, g2], /not offered/],
    ['mismatched coefficient', [{ ...g1, coefficient: 9 }, g2], /coefficient/],
    ['jobIndex not matching its job', [{ ...g1, jobIndex: 1 }, g2], /jobIndex/],
    ['two selections for one job', [g1, g1], /more than once/],
    ['non-finite demand', [{ ...g1, demand: Number.NaN }, g2], /demand/],
  ])('rejects a fallback with %s', (_label, selections, message) => {
    expect(() => run({ outcome: TIMEOUT, fallbackSelections: selections as RecordedScheduleInput['fallbackSelections'] })).toThrow(message);
  });

  it('rejects malformed fallback evidence even when the infeasible status would ignore it', () => {
    expect(() => run({ outcome: outcomeOf({ Status: 'Infeasible' }), fallbackSelections: [{ ...g1, demand: Number.NaN }] })).toThrow(/demand/);
  });

  it('rejects rows naming no recorded job, duplicate variable names, duplicate alternatives and duplicate jobs', () => {
    const orphan = [...ROWS, row('fake-v-9', 'fake-job-missing', 'fake-pool-a', null, 1, 'fake-policy-x')];
    expect(() => run({ outcome: TIMEOUT, fallbackSelections: GREEDY, variables: orphan })).toThrow(/unknown job/);
    const dupName = [...ROWS, row('fake-v-1', 'fake-job-3', 'fake-pool-a', null, 1, 'fake-policy-x')];
    expect(() => run({ outcome: TIMEOUT, fallbackSelections: GREEDY, variables: dupName })).toThrow(/duplicate variable name/);
    const dupAlt = [...ROWS, row('fake-v-5', 'fake-job-1', 'fake-pool-a', null, 2, 'fake-policy-x')];
    expect(() => run({ outcome: TIMEOUT, fallbackSelections: GREEDY, variables: dupAlt })).toThrow(/more than once/);
    const again = { id: 'fake-job-1', jobType: 'coding', canary: false };
    expect(() => run({ outcome: TIMEOUT, fallbackSelections: GREEDY, jobs: [...JOBS, again] })).toThrow(/duplicate job id/);
  });

  it('rejects non-finite recorded evidence and non-null objectives on non-optimal outcomes', () => {
    const base = outcomeOf(optimalRecord({ 'fake-v-1': 1 }, 2));
    expect(() => run({ outcome: { ...base, objective: Number.POSITIVE_INFINITY } })).toThrow(/finite number/);
    expect(() => run({ outcome: { ...base, values: { 'fake-v-1': Number.NaN } } })).toThrow(/finite number/);
    expect(() => run({ outcome: { ...TIMEOUT, objective: 0 }, fallbackSelections: GREEDY })).toThrow(/must be null/);
    expect(() => run({ outcome: null as never })).toThrow(RecordedScheduleResultError);
  });
});

describe('assembleRecordedSchedule: immutability and provenance', () => {
  it('does not mutate frozen inputs and repeat calls match', () => {
    const optimal = outcomeOf(optimalRecord({ 'fake-v-1': 0.49, 'fake-v-2': 0.5, 'fake-v-3': 1, 'fake-v-4': 0 }, 3.5));
    const frozen = deepFreeze({ jobs: JOBS, variables: ROWS, fallbackSelections: GREEDY, optimal, timeout: TIMEOUT });
    const before = JSON.stringify(frozen);
    const first = run({ outcome: frozen.optimal, jobs: frozen.jobs, variables: frozen.variables });
    const timeout = run({ outcome: frozen.timeout, jobs: frozen.jobs, variables: frozen.variables, fallbackSelections: frozen.fallbackSelections });
    expect(JSON.stringify(frozen)).toBe(before);
    expect(JSON.stringify(first)).toBe(JSON.stringify(run({ outcome: optimal })));
    expect(timeout.assignedJobIds).toEqual(['fake-job-1', 'fake-job-2']);
  });

  it('carries pinned historical provenance and never grants merge authority or feasibility', () => {
    expect(RECORDED_SCHEDULE_RESULT_PROVENANCE).toEqual({ source: 'historical-offline', sourcePr: 5952, sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886', basis: 'recorded-schedule-result', grantsMergeAuthority: false });
    const results = [
      run({ outcome: outcomeOf(optimalRecord({ 'fake-v-1': 1 }, 2)) }),
      run({ outcome: outcomeOf({ Status: 'Infeasible' }) }),
      run({ outcome: TIMEOUT, fallbackSelections: GREEDY }),
    ];
    for (const result of results) {
      expect(result).toMatchObject({ provenance: RECORDED_SCHEDULE_RESULT_PROVENANCE, grantsMergeAuthority: false, feasibilityAsserted: false });
      expect(result.decisions.every((d) => d.grantsMergeAuthority === false)).toBe(true);
    }
  });
});
