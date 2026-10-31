import { describe, expect, it } from 'vitest';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';

/* ---------- helpers -------------------------------------------------- */

function input(patch: Partial<NodeContextPackInput> = {}): NodeContextPackInput {
  return {
    node: { jobId: 'node-a', upstreamJobIds: ['job-1', 'job-2', 'job-3', 'job-4', 'job-1'], query: 'test' },
    outputs: [
      { jobId: 'job-1', text: 'First output data.' },
      { jobId: 'job-2', text: '' },
      { jobId: 'job-3', text: '  ' },
      { jobId: 'node-a', text: 'Own output. Do not count.' },
      ...patch.outputs ?? [],
    ],
    tasks: [{ jobId: 'task-1', text: 'A task about test.' }],
    byteBudget: 500,
  };
}

/* ---------- tests ---------------------------------------------------- */

describe('node context coverage', () => {
  it('reports missing-output when input.outputs has no nonblank text for the job', () => {
    /* job-2 and job-3 have blank text in the default fixture. */
    const result = summarizeNodeContextCoverage(input(), buildNodeContextPack(input()));
    expect(result.upstream).toContainEqual({ jobId: 'job-2', state: 'missing-output' });
    expect(result.upstream).toContainEqual({ jobId: 'job-3', state: 'missing-output' });
  });

  it('reports omitted when nonblank output exists but not in pack', () => {
    const i = input({ outputs: [{ jobId: 'job-x', text: 'Real content.' }] });
    const result = summarizeNodeContextCoverage(i, buildNodeContextPack(i));
    expect(result.upstream.map(u => u.jobId)).not.toContain('job-x');
  });

  it('reports truncated when included entries all have truncated:true', () => {
    const i = input({ outputs: [{ jobId: 'job-1', text: 'x'.repeat(200) }] });
    const pack = buildNodeContextPack({ ...i, byteBudget: 80 });
    const result = summarizeNodeContextCoverage(i, pack);
    expect(result.upstream.find(u => u.jobId === 'job-1')).toEqual({ jobId: 'job-1', state: 'truncated' });
  });

  it('reports included when any included entry has truncated:false', () => {
    const result = summarizeNodeContextCoverage(input(), buildNodeContextPack(input()));
    const job1 = result.upstream.find(u => u.jobId === 'job-1');
    expect(job1).toEqual({ jobId: 'job-1', state: 'included' });
  });

  it('excludes the current node jobId from results', () => {
    const result = summarizeNodeContextCoverage(input(), buildNodeContextPack(input()));
    expect(result.upstream.every(u => u.jobId !== 'node-a')).toBe(true);
  });

  it('deduplicates upstream entries by first-occurrence order', () => {
    const result = summarizeNodeContextCoverage(input(), buildNodeContextPack(input()));
    const ids = result.upstream.map(u => u.jobId);
    expect(ids.filter(id => id === 'job-1')).toHaveLength(1);
    expect(ids).toEqual(['job-1', 'job-2', 'job-3', 'job-4']);
  });

  it('ignores task entries when determining coverage state', () => {
    const i = input();
    const result = summarizeNodeContextCoverage(i, buildNodeContextPack(i));
    /* job-3 has blank output → missing-output regardless of task presence. */
    expect(result.upstream.find(u => u.jobId === 'job-3')).toEqual({ jobId: 'job-3', state: 'missing-output' });
  });

  it('ignores malformed JSONL lines', () => {
    const malformed = 'not json\n{"jobId":"job-1","kind":"output","text":"data","truncated":false}\n{bad\n';
    const result = summarizeNodeContextCoverage(input(), malformed);
    expect(result.upstream.find(u => u.jobId === 'job-1')).toEqual({ jobId: 'job-1', state: 'truncated' });
  });

  it('handles a small budget that omits an upstream output entirely', () => {
    const i = input({ outputs: [{ jobId: 'job-4', text: 'Hidden output.' }] });
    const pack = buildNodeContextPack({ ...i, byteBudget: 60 });
    const result = summarizeNodeContextCoverage(i, pack);
    const job4 = result.upstream.find(u => u.jobId === 'job-4');
    expect(job4).toEqual({ jobId: 'job-4', state: 'omitted' });
  });

  it('returns empty upstream when input.outputs is empty for a missing-output job', () => {
    const i = input({ outputs: [{ jobId: 'job-2', text: '' }] });
    const pack = buildNodeContextPack(i);
    const result = summarizeNodeContextCoverage(i, pack);
    const job2 = result.upstream.find(u => u.jobId === 'job-2');
    expect(job2).toEqual({ jobId: 'job-2', state: 'missing-output' });
  });

  it('deterministic: two calls return identical results with no mutation', () => {
    const i = input();
    const pack = buildNodeContextPack(i);
    const r1 = summarizeNodeContextCoverage(i, pack);
    const r2 = summarizeNodeContextCoverage(i, pack);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('no I/O, no mutation, no fetching — pure function contract', () => {
    const i = input();
    const originalNode = structuredClone(i.node);
    const pack = buildNodeContextPack(i);
    const result = summarizeNodeContextCoverage(i, pack);
    /* Original input must be unchanged. */
    expect(JSON.stringify(i.node)).toBe(JSON.stringify(originalNode));
    /* Result is a fresh array — no reference sharing. */
    expect(result.upstream).not.toBe(i.outputs);
  });

  it('handles empty pack gracefully', () => {
    const result = summarizeNodeContextCoverage(input(), '');
    expect(result.upstream).toHaveLength(4);
    expect(result.upstream.find(u => u.jobId === 'job-1')).toEqual({ jobId: 'job-1', state: 'missing-output' });
  });
});
