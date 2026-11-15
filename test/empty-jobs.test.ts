import { describe, expect, it } from 'vitest';
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
    expect(classifyEmpty(null, 'command not found: private-tool')).toEqual({ class: 'blocked-by-env', reason: 'A tool or environment problem blocked the work.' });
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
    expect(report?.jobs[0]).toEqual({ id: 'J1', lane: 'work', class: 'already-done', reason: 'Work was already completed or covered.' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
