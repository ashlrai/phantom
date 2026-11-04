import { expect, it, vi } from 'vitest';
import { parseFleetJobPrecheckBatchArgs, readFleetJobPrecheckBatch } from '../../src/mcp/fleet-job-precheck-batch.js';

it('returns identity-specific evidence from one immutable-ref probe', async () => {
  const resolveRef = vi.fn(async () => 'a'.repeat(40));
  const git = {
    exists: vi.fn(async () => true),
    lastCommit: vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-ONE): landed' })),
  };
  const gitJobProbe = vi.fn(() => git);
  const input = { drafts: [
    { label: 'one', markdown: 'src/shared.ts', jobId: 'RQ-ONE' },
    { label: 'two', markdown: 'src/shared.ts', jobId: 'RQ-TWO' },
    { label: 'RQ-ONE', markdown: 'src/shared.ts' },
  ] };
  const result = await readFleetJobPrecheckBatch(input, { resolveRef, gitJobProbe }) as {
    entries: Array<{ label: string; report: { jobId?: string; verdict: string; facts: Array<{ jobIdMatch?: boolean | null }> } }>;
    counts: Record<string, number>; collisions: unknown[];
  };
  expect(result.entries.map(e => [e.label, e.report.jobId, e.report.verdict, e.report.facts[0]?.jobIdMatch])).toEqual([
    ['one', 'RQ-ONE', 'likely-done', true], ['two', 'RQ-TWO', 'partly-on-master', false],
    ['RQ-ONE', undefined, 'likely-done', undefined],
  ]);
  expect(result.counts).toEqual({ fresh: 0, 'partly-on-master': 1, 'likely-done': 2, errors: 0 });
  expect(result.collisions).toEqual([{ path: 'src/shared.ts', labels: ['one', 'two', 'RQ-ONE'] }]);
  expect(resolveRef).toHaveBeenCalledWith('origin/master');
  expect(gitJobProbe).toHaveBeenCalledWith('a'.repeat(40));
  expect(git.exists).toHaveBeenCalledTimes(1);
  expect(git.lastCommit).toHaveBeenCalledTimes(1);
});

it('never treats missing or unrecognized commit evidence as a match', async () => {
  for (const subject of [null, 'ordinary change']) {
    const result = await readFleetJobPrecheckBatch({ drafts: [{ label: 'a', markdown: 'src/a.ts', jobId: 'RQ-ONE' }] }, {
      resolveRef: async () => 'a'.repeat(40),
      gitJobProbe: () => ({ exists: async () => true, lastCommit: async () => subject ? { sha: 'abc1234', subject } : null }),
    }) as { entries: Array<{ report: { verdict: string; facts: Array<{ jobIdMatch: boolean | null }> } }> };
    expect(result.entries[0]?.report.verdict).toBe('partly-on-master');
    expect(result.entries[0]?.report.facts[0]?.jobIdMatch).toBeNull();
  }
});

it('rejects invalid supplied identities before resolving or probing', async () => {
  const resolveRef = vi.fn(async () => 'a'.repeat(40));
  const gitJobProbe = vi.fn();
  for (const jobId of ['', 'RQ-ONE bad', null, 42, undefined]) {
    const input = { drafts: [{ label: 'a', markdown: 'src/a.ts', jobId }] };
    expect(parseFleetJobPrecheckBatchArgs(input)).toBeNull();
    await expect(readFleetJobPrecheckBatch(input as never, { resolveRef, gitJobProbe })).rejects.toThrow('invalid batch request');
  }
  expect(resolveRef).not.toHaveBeenCalled();
  expect(gitJobProbe).not.toHaveBeenCalled();
});
