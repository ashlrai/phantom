import { describe, expect, it, vi } from 'vitest';
import { runContextDependencyCheck } from '../examples/agents/context-dependency-check.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';
import { parseContextPackArguments } from '../src/mcp/context-server.js';
import type { StableFileReadResult } from '../src/core/util/stable-file-read.js';

const snapshot = () => ({
  node: { jobId: 'fake/target', upstreamJobIds: ['fake/a', 'fake/b'] },
  tasks: [{ jobId: 'fake/a', text: 'Task A' }, { jobId: 'fake/b', text: 'Task B' }],
  outputs: [{ jobId: 'fake/a', text: 'Output A' }, { jobId: 'fake/b', text: 'Output B' }],
  byteBudget: 4096,
});

async function run(value: unknown, args = ['--file', 'fake.json']) {
  let output = '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const read = vi.fn((): StableFileReadResult => ({ ok: true, text, bytesRead: Buffer.byteLength(text), mtimeMs: 0 }));
  const code = await runContextDependencyCheck(args, { read, write: chunk => { output += chunk; } });
  return { code, result: JSON.parse(output), read };
}

describe('context dependency workflow', () => {
  it('returns the canonical scrubbed pack for a healthy snapshot', async () => {
    const input = snapshot();
    const { code, result } = await run(input);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'ready', nodeId: 'fake/target', issues: [],
      sources: { upstream: 'provided', tasks: 'provided', outputs: 'provided' },
      upstream: [{ jobId: 'fake/a', taskInPack: true, outputInPack: true },
        { jobId: 'fake/b', taskInPack: true, outputInPack: true }] });
    expect(result.pack).toBe(buildNodeContextPack(parseContextPackArguments(input)));
    expect(result.packBytes).toBe(Buffer.byteLength(result.pack));
  });

  it('distinguishes absent tasks from blank outputs and reports duplicate IDs by kind', async () => {
    const input = snapshot();
    input.tasks = [{ jobId: 'fake/b', text: ' ' }, { jobId: 'fake/b', text: 'Task B' }];
    input.outputs = [{ jobId: 'fake/a', text: '' }, { jobId: 'fake/a', text: ' \n' }];
    const { code, result } = await run(input);
    expect(code).toBe(1);
    expect(result.issues).toEqual(expect.arrayContaining([
      { code: 'missing_context', kind: 'task', jobId: 'fake/a', reason: 'absent' },
      { code: 'missing_context', kind: 'output', jobId: 'fake/a', reason: 'empty' },
      { code: 'missing_context', kind: 'output', jobId: 'fake/b', reason: 'absent' },
      { code: 'duplicate_record', kind: 'task', jobId: 'fake/b', count: 2 },
      { code: 'duplicate_record', kind: 'output', jobId: 'fake/a', count: 2 },
    ]));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'missing_context', kind: 'task', jobId: 'fake/b' }));
  });

  it('reports a self-dependency and reflects the builder excluding the target output', async () => {
    const input = snapshot();
    input.node.upstreamJobIds = ['fake/target'];
    input.tasks = [{ jobId: 'fake/target', text: 'Task' }];
    input.outputs = [{ jobId: 'fake/target', text: 'Output' }];
    const { code, result } = await run(input);
    expect(code).toBe(1);
    expect(result.issues).toContainEqual({ code: 'self_dependency', jobId: 'fake/target' });
    expect(result.upstream).toEqual([{ jobId: 'fake/target', taskInPack: true, outputInPack: false }]);
  });

  it('preserves unknown versus empty without inventing missing records', async () => {
    const input = { ...snapshot(), tasks: null, outputs: [] };
    const { code, result } = await run(input);
    expect(code).toBe(1);
    expect(result.sources).toEqual({ upstream: 'provided', tasks: 'unknown', outputs: 'provided' });
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue: { kind: string }) => issue.kind === 'output')).toBe(true);
    expect(result.upstream[0]).toEqual({ jobId: 'fake/a', taskInPack: null, outputInPack: false });
    const unknown = await run({ ...snapshot(), node: { jobId: 'fake/target', upstreamJobIds: null } });
    expect(unknown.result).toMatchObject({ status: 'unknown', upstream: null, issues: [] });
    const empty = await run({ ...snapshot(), node: { jobId: 'fake/target', upstreamJobIds: [] }, tasks: [], outputs: [] });
    expect(empty.code).toBe(0);
    expect(empty.result.upstream).toEqual([]);
  });

  it('exposes pack omissions independently of source completeness', async () => {
    const { code, result } = await run({ ...snapshot(), byteBudget: 1 });
    expect(code).toBe(0);
    expect(result.pack).toBe('');
    expect(result.upstream[0]).toEqual({ jobId: 'fake/a', taskInPack: false, outputInPack: false });
  });

  it.each([
    {}, { ...snapshot(), tasks: undefined }, { ...snapshot(), outputs: 'unknown' },
    { ...snapshot(), node: { jobId: 'fake/target' } },
    { ...snapshot(), node: { jobId: '', upstreamJobIds: [] } },
    { ...snapshot(), tasks: [{ jobId: 'fake/a', text: 1 }] },
    { ...snapshot(), byteBudget: 32769 }, { ...snapshot(), unexpected: true },
    { ...snapshot(), node: { jobId: 'fake/target', upstreamJobIds: Array(257).fill('fake/a') } },
  ])('rejects invalid schema or bounds %#', async value => {
    const { code, result } = await run(value);
    expect(code).toBe(2);
    expect(result.error.code).toBe('INVALID_SNAPSHOT');
  });

  it('scrubs text and rejects identities that would be changed by scrubbing', async () => {
    const input = snapshot();
    input.tasks[0]!.text = 'Contact fake@example.com';
    const clean = await run(input);
    expect(clean.result.pack).not.toContain('fake@example.com');
    input.node.jobId = 'fake@example.com';
    const rejected = await run(input);
    expect(rejected.code).toBe(2);
    expect(JSON.stringify(rejected.result)).not.toContain('fake@example.com');
  });

  it('reports JSON, read, and argument failures without echoing inputs', async () => {
    expect((await run('{')).result.error.code).toBe('INVALID_JSON');
    const usage = await run(snapshot(), ['--file', 'x', '--extra']);
    expect(usage.code).toBe(2);
    expect(usage.read).not.toHaveBeenCalled();
    let output = '';
    const code = await runContextDependencyCheck(['--file', 'fake.json'], {
      read: () => ({ ok: false, reason: 'io-error' }), write: text => { output += text; },
    });
    expect(code).toBe(1);
    expect(JSON.parse(output).error.code).toBe('READ_FAILED');
    expect(output).not.toContain('fake.json');
  });
});
