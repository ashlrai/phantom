import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';
import { readNodeContextCitations } from '../src/core/fleet/node-context-citations.js';

describe('readNodeContextCitations', () => {
  it('returns empty array for empty string', () => {
    const citations = readNodeContextCitations('');
    assert.deepEqual(citations, []);
  });

  it('returns empty array for invalid budget', () => {
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: [] },
      tasks: [],
      outputs: [],
      byteBudget: -1,
    });
    const citations = readNodeContextCitations(pack);
    assert.deepEqual(citations, []);
  });

  it('extracts citations from a real context pack', () => {
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: ['job-a', 'job-b'] },
      tasks: [
        { jobId: 'job-a', text: 'Task A content here' },
        { jobId: 'job-b', text: 'Task B content here' },
      ],
      outputs: [
        { jobId: 'job-a', text: 'Output A is ready' },
        { jobId: 'job-b', text: 'Output B done' },
      ],
      byteBudget: 4096,
    });
    const citations = readNodeContextCitations(pack);

    assert.strictEqual(citations.length, 4);
    assert.deepEqual(citations[0], {
      jobId: 'job-a',
      kind: 'output',
      truncated: false,
    });
    assert.deepEqual(citations[1], {
      jobId: 'job-b',
      kind: 'output',
      truncated: false,
    });
    assert.deepEqual(citations[2], {
      jobId: 'job-a',
      kind: 'task',
      truncated: false,
    });
    assert.deepEqual(citations[3], {
      jobId: 'job-b',
      kind: 'task',
      truncated: false,
    });
  });

  it('keeps different kinds for the same job as distinct citations', () => {
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: ['job-x'] },
      tasks: [{ jobId: 'job-x', text: 'Task X text' }],
      outputs: [{ jobId: 'job-x', text: 'Output X text' }],
      byteBudget: 4096,
    });
    const citations = readNodeContextCitations(pack);
    assert.strictEqual(citations.length, 2);

    const task = citations.find(c => c.kind === 'task');
    const output = citations.find(c => c.kind === 'output');
    assert.ok(task && output);
    assert.strictEqual(task.jobId, 'job-x');
    assert.strictEqual(output.jobId, 'job-x');
  });

  it('aggregates duplicate (jobId, kind): later truncation wins', () => {
    // Tight budget lets first output through untruncated, then
    // forces the second output to be truncated (partial text).
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: ['dup-job'] },
      tasks: [],
      outputs: [
        { jobId: 'dup-job', text: 'First output text' },
        { jobId: 'dup-job', text: 'Second output text that is much longer to trigger truncation' },
      ],
      byteBudget: 170,
    });
    const citations = readNodeContextCitations(pack);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].jobId, 'dup-job');
    assert.strictEqual(citations[0].kind, 'output');
    assert.strictEqual(citations[0].truncated, true);
  });

  it('ignores malformed JSON lines', () => {
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: ['job-1'] },
      tasks: [{ jobId: 'job-1', text: 'Valid content' }],
      outputs: [],
      byteBudget: 4096,
    });
    // Inject garbage: non-JSON string, a JSON object missing fields.
    const corrupted = 'not json\n' + pack
      + JSON.stringify({ jobId: 'x', kind: 'task' }) + '\n'
      + JSON.stringify({ jobId: 'y', kind: 'output', text: '' }) + '\n';
    const citations = readNodeContextCitations(corrupted);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].jobId, 'job-1');
  });

  it('skips records missing required fields', () => {
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: ['job-1'] },
      tasks: [{ jobId: 'job-1', text: 'Valid' }],
      outputs: [],
      byteBudget: 4096,
    });
    // Missing `truncated` entirely; empty jobId; missing jobId.
    const mixed = pack
      + JSON.stringify({ jobId: 'a', kind: 'task' }) + '\n'
      + JSON.stringify({ jobId: '', kind: 'output', text: 'empty job', truncated: false }) + '\n'
      + JSON.stringify({ kind: 'task', text: 'missing jobId' }) + '\n';
    const citations = readNodeContextCitations(mixed);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].jobId, 'job-1');
  });

  it('preserves jobId exactly as produced by the builder', () => {
    const fakeJobId = 'U+1F680-fake-9f3a';
    const pack = buildNodeContextPack({
      node: { jobId: 'node-1', upstreamJobIds: [fakeJobId] },
      tasks: [{ jobId: fakeJobId, text: 'Unicode job ID test' }],
      outputs: [],
      byteBudget: 4096,
    });
    const citations = readNodeContextCitations(pack);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].jobId, fakeJobId);
  });
});
