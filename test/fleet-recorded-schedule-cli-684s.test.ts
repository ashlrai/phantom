import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetRecordedSchedule } from '../src/cli/fleet-recorded-schedule.js';
import { recordedGreedyAssignment } from '../src/core/providers/coding-cli/recorded-greedy-assignment.js';
import { normalizeRecordedSolverResult, type RecordedSolverResult } from '../src/core/providers/coding-cli/recorded-solver-result.js';
import {
  assembleRecordedSchedule,
  type RecordedScheduleInput,
  type RecordedScheduleJob,
  type RecordedScheduleResult,
  type RecordedScheduleVariableRow,
} from '../src/core/providers/coding-cli/recorded-schedule-result.js';

// Plainly synthetic identities and numbers. Recovered shape from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886).
const NOW_MS = 1_700_000_000_000;
const MAX_BYTES = 1_000_000;
const ELAPSED = { elapsedMs: 40, budgetMs: 100 };
const normalize = (recorded: RecordedSolverResult) => normalizeRecordedSolverResult(recorded, ELAPSED);

const OPTIMAL = normalize({
  Status: 'Optimal',
  ObjectiveValue: 2.5,
  Columns: {
    'fake-v-1': { Primal: 1 },
    'fake-v-2': { Primal: 0 },
    'fake-v-3': { Primal: 0 },
    'fake-v-4': { Primal: 1 },
  },
});
const INFEASIBLE = normalize({ Status: 'Infeasible' });
const TIMEOUT = normalize({ Status: 'Time limit reached' });
const FAILED = normalize({ Status: 'Solver error' });

const JOBS: RecordedScheduleJob[] = [
  { id: 'fake-job-1', jobType: 'coding', canary: false },
  { id: 'fake-job-2', jobType: 'review', canary: true },
  { id: 'fake-job-3', jobType: 'coding', canary: false },
];
const row = (name: string, jobId: string, poolId: string, consumer: string | null, coefficient: number, policyId: string): RecordedScheduleVariableRow =>
  ({ name, jobId, poolId, consumer, coefficient, policyId });
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

const inputOf = (outcome: RecordedScheduleInput['outcome'], extra: Partial<RecordedScheduleInput> = {}): RecordedScheduleInput => ({
  jobs: JOBS,
  variables: ROWS,
  outcome,
  defaultPolicyId: 'fake-policy-default',
  nowMs: NOW_MS,
  ...extra,
});

describe('fleet recorded-schedule CLI', () => {
  let dir: string;
  let logs: string[];
  let errors: string[];
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recorded-schedule-684s-'));
    logs = [];
    errors = [];
    fetchSpy = vi.fn(() => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };
  const jsonResult = (): { basis: string; availability: string; executionAuthority: string; result: RecordedScheduleResult } =>
    JSON.parse(logs.at(-1)!);
  const allOutput = (): string => [...logs, ...errors].join('\n');

  it('prints the optimal archived result exactly as assembleRecordedSchedule projects it', async () => {
    const input = inputOf(OPTIMAL);
    expect(await cmdFleetRecordedSchedule(['--file', write('optimal.json', input), '--json'])).toBe(0);
    const out = jsonResult();
    expect(out).toMatchObject({ basis: 'recorded-input-only', availability: 'not-current-availability', executionAuthority: 'none' });
    expect(out.result).toEqual(assembleRecordedSchedule(input));
    expect(out.result).toMatchObject({
      status: 'optimal',
      solver: 'highs',
      fallbackReason: null,
      objective: 2.5,
      assignedJobIds: ['fake-job-1', 'fake-job-2'],
      unassignedJobIds: ['fake-job-3'],
      feasibilityAsserted: false,
      grantsMergeAuthority: false,
    });
    expect(out.result.decisions[0]).toMatchObject({ jobId: 'fake-job-1', poolId: 'fake-pool-a', consumer: null, policyId: 'fake-policy-x' });
    expect(out.result.decisions[2]).toMatchObject({ jobId: 'fake-job-3', poolId: null, policyId: 'fake-policy-default' });
  });

  it('prints a human summary with the optimal, selected and unassigned sections and no authority claim', async () => {
    expect(await cmdFleetRecordedSchedule(['--file', write('optimal.json', inputOf(OPTIMAL))])).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('recorded-input-only, not-current-availability, executionAuthority none');
    expect(text).toContain('optimal: the recorded solver reported an optimal solution');
    expect(text).toContain('Selected jobs (2):');
    expect(text).toContain('fake-job-1 (coding; policy fake-policy-x) -> pool fake-pool-a');
    expect(text).toContain('Unassigned jobs (1):');
    expect(text).toContain('does not prove current quota, capacity or permission to dispatch');
  });

  it('projects an infeasible archived outcome with no assignments and no fallback', async () => {
    const input = inputOf(INFEASIBLE, { fallbackSelections: GREEDY });
    expect(await cmdFleetRecordedSchedule(['--file', write('infeasible.json', input), '--json'])).toBe(0);
    const out = jsonResult();
    expect(out.result).toEqual(assembleRecordedSchedule(input));
    expect(out.result).toMatchObject({ status: 'infeasible', fallbackReason: null, objective: null, assignedJobIds: [] });
    expect(out.result.unassignedJobIds).toEqual(['fake-job-1', 'fake-job-2', 'fake-job-3']);
    logs = [];
    expect(await cmdFleetRecordedSchedule(['--file', write('infeasible2.json', input)])).toBe(0);
    expect(logs.join('\n')).toContain('infeasible: the recorded solver reported no feasible assignment');
  });

  it.each([
    ['timeout', TIMEOUT],
    ['failed', FAILED],
  ] as const)('projects %s with the recorded greedy fallback and keeps the unknown objective null', async (label, outcome) => {
    const input = inputOf(outcome, { fallbackSelections: GREEDY });
    expect(await cmdFleetRecordedSchedule(['--file', write(`${label}.json`, input), '--json'])).toBe(0);
    const out = jsonResult();
    expect(out.result).toEqual(assembleRecordedSchedule(input));
    expect(out.result).toMatchObject({ status: 'fallback', solver: 'greedy', fallbackReason: label, objective: null });
    expect(out.result.assignedJobIds).toEqual(['fake-job-1', 'fake-job-2']);
    expect(out.result.decisions[1]).toMatchObject({ jobId: 'fake-job-2', poolId: 'fake-pool-c', fallback: true, solver: 'greedy' });
    logs = [];
    expect(await cmdFleetRecordedSchedule(['--file', write(`${label}-human.json`, input)])).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain(`fallback (${label}): the solver did not finish`);
    expect(text).toContain('Recorded objective: null (unknown; not recorded for this status)');
  });

  it('rejects a timeout with no recorded fallback through the assembler, with a fixed reason', async () => {
    expect(await cmdFleetRecordedSchedule(['--file', write('no-fallback.json', inputOf(TIMEOUT)), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', reason: 'assembler-rejected' });
  });

  it('rejects inconsistent outcome evidence through the assembler', async () => {
    const inconsistent = { ...OPTIMAL, objective: null };
    expect(await cmdFleetRecordedSchedule(['--file', write('inconsistent.json', inputOf(inconsistent)), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', reason: 'assembler-rejected' });
  });

  it('refuses duplicate job identities without echoing them', async () => {
    const marker = 'fake-dup-LEAK-684';
    const jobs = [...JOBS, { id: marker, jobType: 'coding', canary: false }, { id: marker, jobType: 'coding', canary: false }];
    expect(await cmdFleetRecordedSchedule(['--file', write('dup.json', inputOf(INFEASIBLE, { jobs })), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', reason: 'assembler-rejected' });
    expect(allOutput()).not.toContain(marker);
  });

  it('reports the path of an invalid nested field without echoing its value', async () => {
    const marker = 'fake-secret-VALUE-684';
    const bad = { ...inputOf(OPTIMAL), variables: [{ ...ROWS[0], coefficient: marker }, ...ROWS.slice(1)] };
    expect(await cmdFleetRecordedSchedule(['--file', write('bad-number.json', bad), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', path: 'variables[0].coefficient' });
    expect(allOutput()).not.toContain(marker);
  });

  it('rejects non-finite or non-integer numbers and unsupported nested fields without echoing key names', async () => {
    const leakKey = 'fake-unknown-key-LEAK';
    const withKey = { ...inputOf(OPTIMAL), jobs: [{ ...JOBS[0], [leakKey]: true }, ...JOBS.slice(1)] };
    expect(await cmdFleetRecordedSchedule(['--file', write('unknown-key.json', withKey), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', path: 'jobs[0] (unsupported field)' });
    expect(allOutput()).not.toContain(leakKey);

    expect(await cmdFleetRecordedSchedule(['--file', write('bad-now.json', { ...inputOf(OPTIMAL), nowMs: 1.5 }), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', path: 'nowMs' });

    expect(await cmdFleetRecordedSchedule(['--file', write('bad-objective.json', { ...inputOf(OPTIMAL), outcome: { ...OPTIMAL, objective: 'fake-text' } }), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', path: 'outcome.objective' });
  });

  it('rejects null, array and non-object input and malformed JSON without echoing the payload', async () => {
    for (const body of ['null', '[]', '"fake-text"']) {
      logs = [];
      expect(await cmdFleetRecordedSchedule(['--file', write('shape.json', body), '--json'])).toBe(1);
      expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'invalid-recorded-schedule', path: 'input' });
    }
    const leak = 'fake-LEAK-malformed';
    logs = [];
    errors = [];
    expect(await cmdFleetRecordedSchedule(['--file', write('malformed.json', `{"jobs": ${leak}`)])).toBe(1);
    expect(errors.join('\n')).toBe('error: recorded schedule file is not valid JSON');
    expect(await cmdFleetRecordedSchedule(['--file', write('malformed2.json', `{"jobs": ${leak}`), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'malformed-json' });
    expect(allOutput()).not.toContain(leak);
  });

  it('exits 1 for a missing file or a non-regular path, and does not echo the path in JSON', async () => {
    expect(await cmdFleetRecordedSchedule(['--file', join(dir, 'absent.json'), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'unreadable-file' });
    mkdirSync(join(dir, 'subdir'));
    expect(await cmdFleetRecordedSchedule(['--file', join(dir, 'subdir'), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'unreadable-file' });
    expect(await cmdFleetRecordedSchedule(['--file', join(dir, 'absent.json')])).toBe(1);
    expect(errors.at(-1)).toContain('could not read');
  });

  it('refuses a file over 1 MB before reading it and accepts one exactly at the bound', async () => {
    const big = `{"pad":"${'x'.repeat(MAX_BYTES)}"}`;
    expect(await cmdFleetRecordedSchedule(['--file', write('oversize.json', big), '--json'])).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({ error: 'file-too-large' });
    expect(allOutput()).not.toContain('xxxxxxxx');

    const base = JSON.stringify({ ...inputOf(OPTIMAL), defaultPolicyId: 'x' });
    const atBound = JSON.stringify({ ...inputOf(OPTIMAL), defaultPolicyId: 'x'.repeat(1 + MAX_BYTES - base.length) });
    expect(Buffer.byteLength(atBound)).toBe(MAX_BYTES);
    expect(await cmdFleetRecordedSchedule(['--file', write('at-bound.json', atBound), '--json'])).toBe(0);
    expect(jsonResult().result.decisions[2]!.policyId).toHaveLength(MAX_BYTES - base.length + 1);
  });

  it('exits 2 for invalid, duplicate or unknown arguments without reading any file', async () => {
    const file = write('valid.json', inputOf(OPTIMAL));
    const bad = [
      [],
      ['--file'],
      ['--file', '--json'],
      ['--json'],
      ['--file', file, '--file', file],
      ['--file', file, '--json', '--json'],
      ['--file', file, '--bogus'],
      ['--file', file, 'extra'],
      ['--help', '--file', file],
    ];
    for (const args of bad) {
      expect(await cmdFleetRecordedSchedule(args)).toBe(2);
    }
    expect(logs).toEqual([]);
    expect(errors.every((line) => line.includes('invalid fleet recorded-schedule arguments'))).toBe(true);
  });

  it('prints usage for --help with exit 0 and no file or network access', async () => {
    expect(await cmdFleetRecordedSchedule(['--help'])).toBe(0);
    expect(logs[0]).toContain('Usage: ashlr fleet recorded-schedule --file <path> [--json]');
    expect(errors).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never calls the network for a successful projection', async () => {
    expect(await cmdFleetRecordedSchedule(['--file', write('optimal.json', inputOf(OPTIMAL)), '--json'])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
