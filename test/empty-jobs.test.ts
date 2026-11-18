import { describe, expect, it, vi } from 'vitest';
import { classifyEmpty } from '../src/core/fleet/empty-jobs.js';

describe('empty job reasons', () => {
  it.each([
    ['Duplicate of an earlier job J0.', 'duplicate'],
    ['Already implemented in an existing PR.', 'already-done'],
    ['Build failed: EPERM opening the tool.', 'blocked-by-env'],
    ['Missing input from the owner.', 'missing-input'],
    ['A scope extension is needed before proceeding.', 'scope-too-cautious'],
    ['No identifiable reason.', 'other'],
  ])('classifies sample notes (#%#)', (notes, kind) => {
    expect(classifyEmpty(notes, null).class).toBe(kind);
  });
  it('uses the log when notes are unavailable and never returns raw text', () => {
    expect(classifyEmpty(null, 'command not found: private-tool')).toEqual({ class: 'blocked-by-env', reason: 'A tool or environment problem blocked the work.', outcome: 'failed' });
  });
  it.each([
    ['Already implemented on master.', 'already-implemented'],
    ['Already on origin/master.', 'already-implemented'],
    ['Open PR #42 covers this request.', 'duplicate'],
    ['Already covered by open PR #42.', 'duplicate'],
    ['Open PR #42 does not cover this request.', 'unknown'],
    ['Duplicate of the previous job.', 'duplicate'],
    ['Tests failed and changes were reverted.', 'failed'],
    ['Task is too broad. Build failed.', 'failed'],
    ['Tests timed out.', 'failed'],
    ['No changes produced.', 'empty'],
    ['Working tree clean.', 'empty'],
    ['This is not already implemented.', 'unknown'],
    ['RESULT EMPTY', 'unknown'],
    ['Already implemented. Tests: 10 passed, 0 failed.', 'already-implemented'],
  ])('distinguishes the outcome of %s', (text, outcome) => {
    expect(classifyEmpty(text, null).outcome).toBe(outcome);
  });
  it('uses measured failures over a claimed no-op and keeps missing evidence unknown', () => {
    for (const exitCode of [1, 124]) expect(classifyEmpty('Already implemented.', null, { exitCode, poolError: false }).outcome).toBe('failed');
    expect(classifyEmpty('No changes produced.', null, { exitCode: 0, poolError: true }).outcome).toBe('failed');
    expect(classifyEmpty('Tests timed out.', null, { exitCode: 124, poolError: true })).toMatchObject({ class: 'blocked-by-env', outcome: 'failed' });
    expect(classifyEmpty(null, null, { exitCode: 0, poolError: false }).outcome).toBe('empty');
    expect(classifyEmpty(null, null).outcome).toBe('unknown');
    expect(classifyEmpty('Attempt ended.', 'Tests timed out.', { exitCode: 124, poolError: false })).toMatchObject({ class: 'tests-timeout', outcome: 'failed' });
    expect(classifyEmpty(null, ['Already implemented.', ...Array(60).fill('progress')].join('\n')).outcome).toBe('unknown');
  });
});

it('reads notes and log tails for EMPTY ledger rows', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readEmptyJobs } = await import('../src/core/fleet/empty-jobs.js');
  const dir = await mkdtemp(join(tmpdir(), 'empty-jobs-'));
  try {
    const runs = join(dir, 'runs'); const wt = join(dir, 'wt');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(wt, 'J1'), { recursive: true });
    await writeFile(join(runs, 'metrics/jobs.jsonl'), ['J1', 'J2', 'J3', 'OLD'].map(job => JSON.stringify({ event: 'outcome', empty: true, job, lane: 'work', ts: job === 'OLD' ? '2026-11-08T12:00:00Z' : '2026-11-09T12:00:00Z' })).join('\n'));
    await writeFile(join(runs, 'J2.log'), 'Duplicate of an earlier job J1');
    await writeFile(join(runs, 'J3.log'), 'This job was a duplicate');
    await writeFile(join(wt, 'J1/BRIDGE_NOTES.md'), 'Already implemented elsewhere.');
    await writeFile(join(runs, 'J1.log'), 'EPERM');
    const report = await readEmptyJobs(24, runs, wt, Date.parse('2026-11-09T13:00:00Z'));
    expect(report?.counts['already-done']).toBe(1);
    expect(report?.topCauses).toEqual([
      { class: 'duplicate', label: 'Duplicate of an earlier job', count: 2, exampleJob: 'J2' },
      { class: 'already-done', label: 'Work already done', count: 1, exampleJob: 'J1' },
    ]);
    expect(report?.jobs[0]).toEqual({ id: 'J1', lane: 'work', class: 'already-done', reason: 'Work was already completed or covered.', outcome: 'already-implemented' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

describe('decide for empty jobs no rule matched (ASHLR_EMPTY_DECIDE, default off)', () => {
  type Decider = (input: { question: string; options: readonly string[]; context?: string; use?: string }) => Promise<{ choice: string }>;
  const tooBroad = () => vi.fn<Decider>(async () => ({ choice: 'too-broad' }));
  const now = Date.parse('2026-11-09T13:00:00Z');
  const ledger = (ids: string[]) => ids.map(job => JSON.stringify({ event: 'outcome', empty: true, job, lane: 'work', ts: '2026-11-09T12:00:00Z' })).join('\n');
  const reader = (ids: string[], logs: Record<string, string>) => async (path: string) =>
    path.endsWith('jobs.jsonl') ? ledger(ids) : Object.entries(logs).find(([id]) => path.endsWith(`${id}.log`))?.[1] ?? null;
  const read = async (ids: string[], logs: Record<string, string>, options: { decide?: boolean; decider?: Decider }) => {
    const { readEmptyJobs } = await import('../src/core/fleet/empty-jobs.js');
    return (await readEmptyJobs(24, '/runs', '/wt', now, { read: reader(ids, logs), ...options }))!;
  };

  it('flag off: never calls decide and keeps the rule answer', async () => {
    const decider = tooBroad();
    const report = await read(['OFF1'], { OFF1: 'The plan had nine parts.' }, { decider });
    expect(decider).not.toHaveBeenCalled();
    expect(report.jobs).toEqual([{ id: 'OFF1', lane: 'work', class: 'other', reason: 'No known reason found.', outcome: 'unknown' }]);
  });

  it('flag on: asks only about jobs no rule matched, keeps a fixed reason, and marks the source', async () => {
    const decider = tooBroad();
    const report = await read(['ON1', 'ON2', 'ON3'], { ON1: 'The plan had nine parts.', ON2: 'Duplicate of an earlier job ON1' }, { decide: true, decider });
    expect(decider).toHaveBeenCalledTimes(1);
    expect(decider.mock.calls[0]![0]).toMatchObject({ question: 'Why did this job finish with no change?', use: 'empty-job-class',
      options: ['duplicate', 'already-done', 'too-broad', 'tests-timeout', 'blocked-by-env', 'missing-input', 'scope-too-cautious'] });
    expect(decider.mock.calls[0]![0].context).toContain('The plan had nine parts.');
    expect(report.jobs).toEqual([
      { id: 'ON1', lane: 'work', class: 'too-broad', reason: 'The task was too broad.', outcome: 'unknown', source: 'decide' },
      { id: 'ON2', lane: 'work', class: 'duplicate', reason: 'The job duplicated an earlier job.', outcome: 'duplicate' },
      { id: 'ON3', lane: 'work', class: 'other', reason: 'Notes and log were unavailable.', outcome: 'unknown' },
    ]);
    expect(report.counts).toMatchObject({ 'too-broad': 1, duplicate: 1, other: 1 });
    // The answer is kept per job, so a second report makes no second call.
    await read(['ON1'], { ON1: 'The plan had nine parts.' }, { decide: true, decider });
    expect(decider).toHaveBeenCalledTimes(1);
  });

  it('flag on: unknown, an unlisted answer or a failed call leaves the rule answer, and at most five jobs are asked', async () => {
    const ids = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7'];
    const answers = ['unknown', 'made-up', null];
    let asked = 0;
    const decider = vi.fn<Decider>(async () => { const choice = answers[asked++]; if (choice === null) throw new Error('down'); return { choice: choice ?? 'unknown' }; });
    const report = await read(ids, Object.fromEntries(ids.map(id => [id, 'Stopped for a reason the rules do not know.'])), { decide: true, decider });
    expect(decider).toHaveBeenCalledTimes(5);
    expect(report.jobs.every(job => job.class === 'other' && job.source === undefined)).toBe(true);
  });

  it('reads the flag from the environment, and a retry is never queued from a model answer', async () => {
    const decider = tooBroad();
    vi.stubEnv('ASHLR_EMPTY_DECIDE', '1');
    try {
      const report = await read(['ENV1'], { ENV1: 'The plan had nine parts.' }, { decider });
      expect(report.jobs[0]).toMatchObject({ class: 'too-broad', source: 'decide' });
      const queue = '- DONE ENV1 (P1, pool=work, tier=mid, repo=phantom, size<=200, src=leader): Do the thing.';
      const { planEmptyRetries } = await import('../src/cli/jobs-retry-empty.js');
      expect(planEmptyRetries(queue, report.jobs, new Set())).toEqual([]);
      expect(planEmptyRetries(queue, [{ ...report.jobs[0]!, source: undefined }], new Set())).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); }
  });
});
