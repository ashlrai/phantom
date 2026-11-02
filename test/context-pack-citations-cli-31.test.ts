/**
 * RQ-PHX-CONTEXTCITEWIRE31 — wires readNodeContextCitations into
 * `phm knowledge context-pack`: --citations reports which jobs and kinds
 * the pack cites, the truncated citation count, the malformed line count
 * and the pack size in bytes, in text and --json output. Malformed pack
 * lines are counted, never thrown.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import * as packBuilder from '../src/core/fleet/node-context-pack.js';

let out: string;
let err: string;

beforeEach(() => {
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

function stream(value: unknown): Readable {
  return Readable.from([JSON.stringify(value)]);
}

async function run(value: unknown, ...flags: string[]): Promise<number> {
  return runKnowledgeContextPack(['--stdin', ...flags], stream(value));
}

const snapshot = () => ({
  node: { jobId: 'join', upstreamJobIds: ['left', 'right'] },
  tasks: [
    { jobId: 'left', text: 'left task' },
    { jobId: 'right', text: 'right task' },
    { jobId: 'join', text: 'join task' },
  ],
  outputs: [
    { jobId: 'left', text: 'left output' },
    { jobId: 'right', text: 'right output' },
  ],
  byteBudget: 4096,
});

describe('knowledge context-pack --citations', () => {
  it('lists cited jobs and kinds with totals in text mode instead of the raw pack', async () => {
    const data = snapshot();
    expect(await run(data, '--citations')).toBe(0);
    const pack = packBuilder.buildNodeContextPack(data);
    expect(out).toBe(
      'citations: 5\n' +
      '- left (output)\n' +
      '- right (output)\n' +
      '- left (task)\n' +
      '- right (task)\n' +
      '- join (task)\n' +
      'truncated: 0\n' +
      'malformed lines: 0\n' +
      `pack bytes: ${Buffer.byteLength(pack, 'utf8')}\n`);
    expect(err).toBe('');
  });

  it('adds a citations object to the JSON envelope without changing existing fields', async () => {
    const data = snapshot();
    expect(await run(data, '--citations', '--json')).toBe(0);
    const pack = packBuilder.buildNodeContextPack(data);
    const body = JSON.parse(out) as Record<string, unknown>;
    expect(body.v).toBe(1);
    expect(body.jobId).toBe('join');
    expect(body.pack).toBe(pack);
    expect(body.bytes).toBe(Buffer.byteLength(pack, 'utf8'));
    expect(body.citations).toEqual({
      records: [
        { jobId: 'left', kind: 'output', truncated: false },
        { jobId: 'right', kind: 'output', truncated: false },
        { jobId: 'left', kind: 'task', truncated: false },
        { jobId: 'right', kind: 'task', truncated: false },
        { jobId: 'join', kind: 'task', truncated: false },
      ],
      citationCount: 5,
      truncatedCitationCount: 0,
      malformedLineCount: 0,
      packBytes: Buffer.byteLength(pack, 'utf8'),
    });
    expect(err).toBe('');
  });

  it('flags a truncated entry in both text and JSON reports', async () => {
    const data = snapshot();
    data.outputs = [{ jobId: 'left', text: 'x'.repeat(500) }];
    data.byteBudget = 200;

    expect(await run(data, '--citations')).toBe(0);
    expect(out).toContain('- left (output, truncated)');
    expect(out).toContain('citations: 1');
    expect(out).toContain('truncated: 1');
    expect(out).toContain(`pack bytes: ${Buffer.byteLength(packBuilder.buildNodeContextPack(data), 'utf8')}`);

    out = '';
    expect(await run(data, '--citations', '--json')).toBe(0);
    const body = JSON.parse(out) as { citations: { records: unknown[]; truncatedCitationCount: number } };
    expect(body.citations.records).toEqual([{ jobId: 'left', kind: 'output', truncated: true }]);
    expect(body.citations.truncatedCitationCount).toBe(1);
    expect(err).toBe('');
  });

  it('counts malformed pack lines instead of throwing', async () => {
    const data = snapshot();
    const real = packBuilder.buildNodeContextPack(data);
    vi.spyOn(packBuilder, 'buildNodeContextPack')
      .mockReturnValue('not json\n' + real + '{"jobId":"x"}\n');

    expect(await run(data, '--citations', '--json')).toBe(0);
    const body = JSON.parse(out) as { pack: string; citations: {
      records: unknown[]; citationCount: number; malformedLineCount: number } };
    expect(body.citations.malformedLineCount).toBe(2);
    expect(body.citations.citationCount).toBe(5);
    expect(body.citations.records).not.toContainEqual(expect.objectContaining({ jobId: 'x' }));

    out = '';
    expect(await run(data, '--citations')).toBe(0);
    expect(out).toContain('malformed lines: 2');
    expect(out).toContain('citations: 5');
    expect(err).toBe('');
  });

  it('appends a Citations section to --markdown output', async () => {
    expect(await run(snapshot(), '--markdown', '--citations')).toBe(0);
    expect(out).toContain('## Citations');
    expect(out).toContain('- left (output)');
    expect(out).toContain('truncated: 0');
    expect(out).toContain('pack bytes:');
    expect(err).toBe('');
  });
});
