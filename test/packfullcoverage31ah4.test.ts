import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import type { NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

const flag = '--require-complete-upstream-outputs';

function fixture(): NodeContextPackInput {
  return {
    node: { jobId: 'self', upstreamJobIds: ['complete', 'partial', 'absent', 'blank', 'omitted', 'partial', 'self'] },
    tasks: [],
    outputs: [
      { jobId: 'complete', text: 'done' },
      { jobId: 'partial', text: '雪🌍'.repeat(20) },
      { jobId: 'omitted', text: 'available' },
      { jobId: 'blank', text: '  ' },
      { jobId: 'self', text: 'not predecessor evidence' },
    ],
    byteBudget: 4096,
  };
}

async function run(input: NodeContextPackInput, ...flags: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runKnowledgeContextPack(['--stdin', ...flags], Readable.from([JSON.stringify(input)]), {
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('complete upstream output coverage', () => {
  it('reports every distinct non-self upstream, including UTF-8 truncation and omissions', async () => {
    const input = fixture();
    const complete = JSON.stringify({ jobId: 'complete', kind: 'output', text: 'done', truncated: false }) + '\n';
    const partial = JSON.stringify({ jobId: 'partial', kind: 'output', text: '雪🌍', truncated: true }) + '\n';
    input.byteBudget = Buffer.byteLength(complete + partial, 'utf8');
    const { code, stdout, stderr } = await run(input, '--json', '--report', flag);
    expect(code).toBe(1);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      pack: complete + partial, bytes: input.byteBudget,
      report: { truncatedRecordCount: 1 },
      check: { upstreamOutputCoverage: [
        { jobId: 'complete', state: 'included' },
        { jobId: 'partial', state: 'truncated' },
        { jobId: 'absent', state: 'missing-output' },
        { jobId: 'blank', state: 'missing-output' },
        { jobId: 'omitted', state: 'omitted' },
      ] },
    });
  });

  it('passes when all distinct non-self upstreams have complete outputs, including an empty set', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['complete', 'partial', 'complete', 'self'];
    let result = await run(input, '--json', flag);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).check.upstreamOutputCoverage).toEqual([
      { jobId: 'complete', state: 'included' }, { jobId: 'partial', state: 'included' },
    ]);
    input.node.upstreamJobIds = ['self', 'self'];
    result = await run(input, '--json', flag);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).check.upstreamOutputCoverage).toEqual([]);
  });

  it('preserves presence-only checking for truncated outputs and composes both checks', async () => {
    const input = fixture();
    input.node.upstreamJobIds = ['partial'];
    input.outputs = [{ jobId: 'partial', text: '雪🌍'.repeat(20) }];
    input.byteBudget = Buffer.byteLength(JSON.stringify({ jobId: 'partial', kind: 'output', text: '雪', truncated: true }) + '\n');
    const presence = await run(input, '--json', '--require-upstream-outputs');
    expect(presence.code).toBe(0);
    expect(JSON.parse(presence.stdout).check).toEqual({ missingUpstreamOutputJobIds: [] });
    const both = await run(input, '--json', '--require-upstream-outputs', flag);
    expect(both.code).toBe(1);
    expect(JSON.parse(both.stdout).check).toEqual({ missingUpstreamOutputJobIds: [],
      upstreamOutputCoverage: [{ jobId: 'partial', state: 'truncated' }] });
  });

  it('works through the public knowledge dispatcher and keeps failure output as JSON lines', async () => {
    const input = fixture();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([JSON.stringify(input)]) as typeof process.stdin);
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
    expect(await cmdKnowledge(['context-pack', '--stdin', '--json', flag])).toBe(1);
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].check.upstreamOutputCoverage).toContainEqual({ jobId: 'absent', state: 'missing-output' });
    expect(lines[1]).toEqual({ error: true, exitCode: 1 });
    expect(stderr).toBe('');
  });

  it('requires JSON, rejects duplicate flags and does not consume the flag as a query', async () => {
    const noJson = await run(fixture(), flag);
    expect(noJson.code).toBe(2);
    expect(noJson.stderr).toContain(`${flag} requires --json`);
    expect(noJson.stdout).toBe('');
    const duplicate = await run(fixture(), '--json', flag, flag);
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('Unexpected argument');
    const query = await run(fixture(), '--json', '--query', flag);
    expect(query.code).toBe(2);
    expect(query.stderr).toContain('--query requires');
  });

  it('documents the complete coverage contract in command help', async () => {
    let help = '';
    expect(await runKnowledgeContextPack(['--help'], Readable.from([]), {
      stdout: text => { help += text; }, stderr: () => {},
    })).toBe(0);
    expect(help).toContain(`${flag} requires --json`);
    expect(help).toContain('missing-output');
    expect(help).toContain('omitted');
    expect(help).toContain('truncated');
    expect(help).toContain('Returns 1 unless every state is included');
  });
});
