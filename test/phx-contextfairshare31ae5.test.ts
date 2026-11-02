import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

type Row = { jobId: string; kind: string; text: string; truncated: boolean };
function rows(pack: string): Row[] {
  return pack.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
}
function fixture(): NodeContextPackInput {
  return {
    node: { jobId: 'fake/current', upstreamJobIds: ['fake/a', 'fake/b', 'fake/c'] },
    outputs: [
      { jobId: 'fake/a', text: 'fake long output '.repeat(300) },
      { jobId: 'fake/b', text: 'fake second output' },
      { jobId: 'fake/c', text: 'fake third output' },
    ],
    tasks: [{ jobId: 'fake/current', text: 'fake task' }],
    byteBudget: 500,
  };
}
async function cli(input: NodeContextPackInput, flags: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runKnowledgeContextPack(['--stdin', ...flags], Readable.from([JSON.stringify(input)]), {
    stdout: text => { out += text; }, stderr: text => { err += text; },
  });
  return { code, out, err };
}

describe('fair upstream context allocation', () => {
  it('reserves citations for three jobs before expanding the first by priority', () => {
    const input = fixture();
    const normal = rows(buildNodeContextPack(input));
    const pack = buildNodeContextPack({ ...input, fairUpstream: true });
    const result = rows(pack);
    expect(normal.map(row => row.jobId)).toEqual(['fake/a']);
    expect(result.map(row => row.jobId)).toEqual(['fake/a', 'fake/b', 'fake/c']);
    expect(result[0]!.text.length).toBeGreaterThan(result[1]!.text.length);
    expect(result[0]!.truncated).toBe(true);
    expect(result[1]!.text).toBe(input.outputs[1]!.text);
    expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(input.byteBudget);
    expect(buildNodeContextPack({ ...input, fairUpstream: true })).toBe(pack);
  });

  it('reports omitted eligible outputs and preserves the existing required-output check', async () => {
    const input = fixture();
    input.byteBudget = 1;
    input.node.upstreamJobIds = ['fake/c', 'fake/a', 'fake/b', 'fake/c', 'fake/no-output'];
    const result = await cli(input, ['--fair-upstream', '--json', '--report', '--require-upstream-outputs']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(JSON.parse(result.out)).toMatchObject({ pack: '', bytes: 0, report: {
      requestedByteBudget: 1, emittedBytes: 0, emittedRecordCount: 0, citedJobIds: [],
      truncatedRecordCount: 0, fairUpstreamMissingOutputJobIds: ['fake/c', 'fake/a', 'fake/b'],
    }, check: { missingUpstreamOutputJobIds: ['fake/c', 'fake/a', 'fake/b', 'fake/no-output'] } });
  });

  it('counts escaped Unicode and citation bytes exactly at every small budget', () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/🌍"', 'fake/b', 'fake/c'];
    input.outputs = [
      { jobId: 'fake/🌍"', text: '🌍漢"\\\n'.repeat(30) },
      { jobId: 'fake/b', text: '雪\n"'.repeat(20) },
      { jobId: 'fake/c', text: '🐈\\'.repeat(20) },
    ];
    input.tasks = [];
    for (let budget = 1; budget <= 500; budget++) {
      const pack = buildNodeContextPack({ ...input, fairUpstream: true, byteBudget: budget });
      expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(budget);
      for (const row of rows(pack)) {
        const source = input.outputs.find(item => item.jobId === row.jobId)!;
        expect(source.text.startsWith(row.text)).toBe(true);
        expect(row.text).not.toContain('\uFFFD');
        expect(row.truncated).toBe(row.text !== source.text);
      }
    }
    expect(rows(buildNodeContextPack({ ...input, fairUpstream: true, byteBudget: 500 })).map(row => row.jobId))
      .toEqual(input.node.upstreamJobIds);
  });

  it('suppresses exact duplicates and reserves only one slice per distinct job', () => {
    const input = fixture();
    input.node.upstreamJobIds = ['fake/a', 'fake/a', 'fake/b', 'fake/c'];
    input.outputs = [input.outputs[0]!, input.outputs[0]!, { jobId: 'fake/a', text: 'fake alternative' },
      input.outputs[1]!, input.outputs[2]!, input.outputs[2]!];
    const result = rows(buildNodeContextPack({ ...input, fairUpstream: true }));
    expect(result.filter(row => row.jobId === 'fake/a')).toHaveLength(1);
    expect(result.map(row => row.jobId)).toEqual(['fake/a', 'fake/b', 'fake/c']);
    const full = rows(buildNodeContextPack({ ...input, fairUpstream: true, byteBudget: 10000 }));
    expect(full.map(row => row.jobId)).toEqual(['fake/a', 'fake/a', 'fake/b', 'fake/c', 'fake/current']);
  });

  it('keeps the default byte-for-byte output and accepts explicit false', async () => {
    const input = fixture();
    input.byteBudget = 100;
    const expected = '{"jobId":"fake/a","kind":"output","text":"' + 'fake long output '.repeat(2) +
      'fake","truncated":true}\n';
    expect(Buffer.byteLength(expected)).toBe(100);
    expect(buildNodeContextPack(input)).toBe(expected);
    expect(buildNodeContextPack({ ...input, fairUpstream: false })).toBe(expected);
    const result = await cli(input, []);
    expect(result).toEqual({ code: 0, out: expected, err: '' });
  });

  it('passes the flag to the real builder and reports actual partial records', async () => {
    const input = fixture();
    const result = await cli(input, ['--fair-upstream', '--json', '--report']);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as { pack: string; bytes: number; report: Record<string, unknown> };
    expect(body.pack).toBe(buildNodeContextPack({ ...input, fairUpstream: true }));
    expect(body.bytes).toBe(Buffer.byteLength(body.pack));
    expect(body.report).toMatchObject({ emittedBytes: body.bytes, emittedRecordCount: 3,
      citedJobIds: ['fake/a', 'fake/b', 'fake/c'], truncatedRecordCount: 1, fairUpstreamMissingOutputJobIds: [] });
    expect(rows(body.pack)[0]!.truncated).toBe(true);
    const invalid = await cli(input, ['--query', '--fair-upstream']);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('--query requires');
  });
});
