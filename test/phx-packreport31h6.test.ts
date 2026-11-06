import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';

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

describe('knowledge context-pack report', () => {
  it('describes the emitted UTF-8 JSONL, including distinct citations and truncation', async () => {
    const first = { jobId: 'fake/upstream-雪', kind: 'output', text: 'Result 🌍', truncated: false };
    const second = { jobId: 'fake/upstream-雪', kind: 'task', text: 'Task 雪', truncated: false };
    const third = { jobId: 'fake/current', kind: 'task', text: 'Review 🌍', truncated: true };
    const expectedPack = [first, second, third].map(row => JSON.stringify(row) + '\n').join('');
    const byteBudget = Buffer.byteLength(expectedPack, 'utf8');
    const snapshot = {
      node: { jobId: 'fake/current', upstreamJobIds: ['fake/upstream-雪'] },
      outputs: [{ jobId: first.jobId, text: first.text }],
      tasks: [{ jobId: second.jobId, text: second.text },
        { jobId: third.jobId, text: third.text + ' more context that cannot fit' }],
      byteBudget,
    };

    expect(await runKnowledgeContextPack(['--stdin', '--json'], stream(snapshot))).toBe(0);
    const original = JSON.parse(out) as { v: number; jobId: string; pack: string; bytes: number };
    expect(original).toEqual({ v: 1, jobId: 'fake/current', pack: expectedPack, bytes: byteBudget });
    expect(byteBudget).toBeGreaterThan(expectedPack.length);

    out = '';
    expect(await runKnowledgeContextPack(['--report', '--stdin', '--json'], stream(snapshot))).toBe(0);
    expect(JSON.parse(out)).toEqual({
      ...original,
      report: {
        requestedByteBudget: byteBudget,
        emittedBytes: byteBudget,
        emittedRecordCount: 3,
        citedJobIds: ['fake/upstream-雪', 'fake/current'],
        truncatedRecordCount: 1,
      },
    });
    expect(err).toBe('');
  });

  it('reports an empty pack when nothing matches', async () => {
    const snapshot = {
      node: { jobId: 'fake/current', upstreamJobIds: [], query: 'needle' },
      tasks: [{ jobId: 'fake/other', text: 'unrelated' }], outputs: [], byteBudget: 512,
    };
    expect(await runKnowledgeContextPack(['--stdin', '--json', '--report'], stream(snapshot))).toBe(0);
    expect(JSON.parse(out)).toEqual({
      v: 1, jobId: 'fake/current', pack: '', bytes: 0,
      report: { requestedByteBudget: 512, emittedBytes: 0, emittedRecordCount: 0, citedJobIds: [], truncatedRecordCount: 0 },
    });
  });

  it('rejects report without json before consuming the input', async () => {
    const input = new Readable({ read() { throw new Error('unexpected read'); } });
    expect(await runKnowledgeContextPack(['--stdin', '--report'], input)).toBe(2);
    expect(input.readableDidRead).toBe(false);
    expect(out).toBe('');
    expect(err).toContain('--report requires --json');
    input.destroy();
  });

  it('keeps snapshot validation and argument validation with report enabled', async () => {
    expect(await runKnowledgeContextPack(['--stdin', '--json', '--report'], stream({ byteBudget: 0 }))).toBe(2);
    expect(err).toContain('invalid shape or byteBudget');
    expect(out).toBe('');
    err = '';
    expect(await runKnowledgeContextPack(['--stdin', '--json', '--report', '--report'], stream({}))).toBe(2);
    expect(err).toContain('Unexpected argument or flag');
    expect(out).toBe('');
  });

  it('documents the report and its json requirement in help', async () => {
    expect(await runKnowledgeContextPack(['--help'])).toBe(0);
    expect(out).toContain('--report requires --json');
    expect(out).toContain('citedJobIds');
    expect(out).toContain('truncatedRecordCount');
  });
});
