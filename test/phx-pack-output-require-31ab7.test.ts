import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

let out: string;
let err: string;

beforeEach(() => {
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

function fixture(): NodeContextPackInput {
  return {
    node: { jobId: 'fake/current', upstreamJobIds: ['fake/b', 'fake/a', 'fake/b'] },
    tasks: [{ jobId: 'fake/b', text: 'Task B' }, { jobId: 'fake/a', text: 'Task A' }],
    outputs: [], byteBudget: 4096,
  };
}

async function run(input: NodeContextPackInput, ...flags: string[]): Promise<number> {
  return runKnowledgeContextPack(['--stdin', ...flags], Readable.from([JSON.stringify(input)]));
}

function result(): {
  pack: string; bytes: number;
  check: { missingUpstreamJobIds?: string[]; missingUpstreamOutputJobIds?: string[] };
  report?: { truncatedRecordCount: number; emittedRecordCount: number };
} {
  return JSON.parse(out) as ReturnType<typeof result>;
}

describe('context pack required upstream outputs', () => {
  it('rejects task-only evidence while retaining the original check semantics', async () => {
    const input = fixture();
    expect(await run(input, '--json', '--require-upstream')).toBe(0);
    expect(result().check).toEqual({ missingUpstreamJobIds: [] });
    out = '';
    expect(await run(input, '--json', '--require-upstream-outputs')).toBe(1);
    expect(result().check).toEqual({ missingUpstreamOutputJobIds: ['fake/b', 'fake/a'] });
    expect(result().pack).toBe(buildNodeContextPack(input));
    expect(err).toBe('');
  });

  it('checks emitted outputs after budgeting, counting truncated evidence and reporting it', async () => {
    const input = fixture();
    input.outputs = [{ jobId: 'fake/a', text: '雪🌍'.repeat(50) }, { jobId: 'fake/b', text: 'Output B' }];
    const first = JSON.stringify({ jobId: 'fake/a', kind: 'output', text: '雪🌍', truncated: true }) + '\n';
    input.byteBudget = Buffer.byteLength(first, 'utf8');
    expect(await run(input, '--json', '--report', '--require-upstream-outputs')).toBe(1);
    expect(result()).toMatchObject({ pack: first, bytes: input.byteBudget,
      check: { missingUpstreamOutputJobIds: ['fake/b'] },
      report: { truncatedRecordCount: 1, emittedRecordCount: 1 } });
  });

  it('accepts emitted outputs and an empty dependency list', async () => {
    const input = fixture();
    input.outputs = [{ jobId: 'fake/a', text: 'Output A' }, { jobId: 'fake/b', text: 'Output B' }];
    expect(await run(input, '--json', '--require-upstream-outputs')).toBe(0);
    expect(result().check).toEqual({ missingUpstreamOutputJobIds: [] });
    expect(result().pack).toBe(buildNodeContextPack(input));
    out = '';
    input.node.upstreamJobIds = []; input.tasks = []; input.outputs = []; input.byteBudget = 1;
    expect(await run(input, '--json', '--require-upstream-outputs')).toBe(0);
    expect(result()).toEqual({ v: 1, jobId: 'fake/current', pack: '', bytes: 0,
      check: { missingUpstreamOutputJobIds: [] } });
  });

  it('composes both checks in one object and retains the partial pack through the knowledge command', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/b', 'fake/missing', 'fake/a', 'fake/missing'];
    input.outputs = [{ jobId: 'fake/a', text: 'Output A' }];
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([JSON.stringify(input)]) as typeof process.stdin);
    expect(await cmdKnowledge(['context-pack', '--stdin', '--json', '--require-upstream', '--require-upstream-outputs'])).toBe(1);
    const [packLine, errorLine] = out.trimEnd().split('\n');
    expect(JSON.parse(packLine)).toEqual({ v: 1, jobId: 'fake/current', pack: buildNodeContextPack(input),
      bytes: Buffer.byteLength(buildNodeContextPack(input)), check: {
        missingUpstreamJobIds: ['fake/missing'], missingUpstreamOutputJobIds: ['fake/b', 'fake/missing'],
      } });
    expect(JSON.parse(errorLine)).toEqual({ error: true, exitCode: 1 });
  });

  it('requires JSON, rejects duplicates and does not consume the flag as a query', async () => {
    const stream = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack(['--stdin', '--require-upstream-outputs'], stream)).toBe(2);
    expect(stream.readableDidRead).toBe(false);
    expect(err).toContain('--require-upstream-outputs requires --json');
    stream.destroy();
    err = '';
    expect(await run(fixture(), '--json', '--require-upstream-outputs', '--require-upstream-outputs')).toBe(2);
    expect(err).toContain('Unexpected argument or flag');
    err = '';
    expect(await run(fixture(), '--json', '--query', '--require-upstream-outputs')).toBe(2);
    expect(err).toContain('--query requires');
    expect(out).toBe('');
  });

  it('documents that truncated outputs are evidence of presence, not task success', async () => {
    expect(await runKnowledgeContextPack(['--help'])).toBe(0);
    expect(out).toContain('--require-upstream-outputs requires --json');
    expect(out).toContain('including truncated outputs');
    expect(out).toContain('not task success');
  });
});
