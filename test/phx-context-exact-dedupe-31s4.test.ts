import { describe, expect, it } from 'vitest';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

type Entry = { jobId: string; kind: 'task' | 'output'; text: string; truncated: boolean };

function entries(pack: string): Entry[] {
  return pack ? pack.trimEnd().split('\n').map(line => JSON.parse(line) as Entry) : [];
}

function line(jobId: string, kind: Entry['kind'], text: string, truncated = false): string {
  return JSON.stringify({ jobId, kind, text, truncated }) + '\n';
}

describe('exact context record deduplication', () => {
  it('retains distinct upstream evidence within a tight UTF-8 budget', () => {
    const first = { jobId: 'fake/α', text: '雪🌍 output' };
    const second = { jobId: 'fake/β', text: 'other evidence' };
    const expected = line(first.jobId, 'output', first.text) + line(second.jobId, 'output', second.text);
    const input: NodeContextPackInput = {
      node: { jobId: 'fake/review', upstreamJobIds: [first.jobId, second.jobId] },
      outputs: [first, { ...first }, second], tasks: [], byteBudget: Buffer.byteLength(expected),
    };
    expect(input.byteBudget).toBeGreaterThan(expected.length);
    expect(buildNodeContextPack(input)).toBe(expected);
  });

  it('distinguishes job IDs, kinds and revisions while preserving ranking and first occurrence order', () => {
    const input: NodeContextPackInput = {
      node: { jobId: 'fake/current', upstreamJobIds: ['fake/a', 'fake/b'], query: 'needle extra' },
      outputs: [
        { jobId: 'fake/outside-low', text: 'needle' },
        { jobId: 'fake/a', text: 'same' },
        { jobId: 'fake/a', text: 'same' },
        { jobId: 'fake/b', text: 'same' },
        { jobId: 'fake/a', text: 'same revision 2' },
        { jobId: 'fake/outside-high', text: 'needle extra' },
        { jobId: 'fake/current', text: 'own output' },
      ],
      tasks: [
        { jobId: 'fake/b', text: 'same' },
        { jobId: 'fake/a', text: 'same' },
        { jobId: 'fake/b', text: 'same' },
        { jobId: 'fake/current', text: 'current task' },
        { jobId: 'fake/outside-low', text: 'needle' },
      ],
      byteBudget: 4096,
    };
    const expected: Entry[] = [
      { jobId: 'fake/a', kind: 'output', text: 'same', truncated: false },
      { jobId: 'fake/b', kind: 'output', text: 'same', truncated: false },
      { jobId: 'fake/a', kind: 'output', text: 'same revision 2', truncated: false },
      { jobId: 'fake/b', kind: 'task', text: 'same', truncated: false },
      { jobId: 'fake/a', kind: 'task', text: 'same', truncated: false },
      { jobId: 'fake/current', kind: 'task', text: 'current task', truncated: false },
      { jobId: 'fake/outside-high', kind: 'output', text: 'needle extra', truncated: false },
      { jobId: 'fake/outside-low', kind: 'output', text: 'needle', truncated: false },
      { jobId: 'fake/outside-low', kind: 'task', text: 'needle', truncated: false },
    ];
    const snapshot = structuredClone(input);
    const pack = buildNodeContextPack(input);
    expect(entries(pack)).toEqual(expected);
    expect(buildNodeContextPack(input)).toBe(pack);
    expect(input).toEqual(snapshot);
  });

  it('preserves byte limits, complete citations and Unicode-safe truncation for every budget', () => {
    const jobId = 'fake/"雪\n';
    const text = '🌍漢字"\\\n'.repeat(20);
    const input: NodeContextPackInput = {
      node: { jobId: 'fake/current', upstreamJobIds: [jobId] },
      outputs: [{ jobId, text }, { jobId, text }], tasks: [], byteBudget: 0,
    };
    const full = line(jobId, 'output', text);
    for (let budget = 0; budget <= Buffer.byteLength(full) + 1; budget++) {
      const pack = buildNodeContextPack({ ...input, byteBudget: budget });
      expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(budget);
      const rows = entries(pack);
      expect(rows.length).toBeLessThanOrEqual(1);
      for (const row of rows) {
        expect(row.jobId).toBe(jobId);
        expect(row.kind).toBe('output');
        expect(text.startsWith(row.text)).toBe(true);
        expect(row.text).not.toContain('\uFFFD');
        expect(row.truncated).toBe(budget < Buffer.byteLength(full));
      }
    }
    expect(buildNodeContextPack({ ...input, byteBudget: Buffer.byteLength(full) + 0.9 })).toBe(full);
    for (const byteBudget of [-1, 0, 0.9, NaN, Infinity]) {
      expect(buildNodeContextPack({ ...input, byteBudget })).toBe('');
    }
  });
});
