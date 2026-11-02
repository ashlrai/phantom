import { describe, expect, it } from 'vitest';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

const fixture: NodeContextPackInput = {
  node: { jobId: 'review', upstreamJobIds: ['build'], query: 'routing' },
  outputs: [
    { jobId: 'unrelated', text: 'routing '.repeat(20) },
    { jobId: 'build', text: 'Built routing fix.' },
    { jobId: 'review', text: 'Do not retrieve own output.' },
  ],
  tasks: [
    { jobId: 'other', text: 'Garden maintenance.' },
    { jobId: 'build', text: 'Implement routing.' },
    { jobId: 'review', text: 'Review fix.' },
  ],
  byteBudget: 1000,
};

function entries(pack: string): { jobId: string; kind: string; text: string; truncated: boolean }[] {
  return pack ? pack.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
}

describe('node context pack', () => {
  it('prioritizes upstream outputs before tasks and unrelated lexical matches', () => {
    const pack = buildNodeContextPack(fixture);
    expect(entries(pack).map(row => [row.jobId, row.kind])).toEqual([
      ['build', 'output'], ['build', 'task'], ['review', 'task'], ['unrelated', 'output'],
    ]);
    const firstLine = pack.split('\n')[0]! + '\n';
    expect(buildNodeContextPack({ ...fixture, byteBudget: Buffer.byteLength(firstLine) })).toBe(firstLine);
  });

  it('bounds every byte budget with oversized Unicode and JSON-escaped text', () => {
    const input = {
      ...fixture,
      outputs: [{ jobId: 'build', text: '🌍漢字"\\\n'.repeat(100) }],
      tasks: [],
    };
    for (let byteBudget = 0; byteBudget <= 600; byteBudget++) {
      const pack = buildNodeContextPack({ ...input, byteBudget });
      expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(byteBudget);
      for (const row of entries(pack)) {
        expect(row.jobId).toBe('build');
        expect(input.outputs[0]!.text.startsWith(row.text)).toBe(true);
        expect(row.text).not.toContain('\uFFFD');
        expect(row.truncated).toBe(true);
      }
    }
    expect(entries(buildNodeContextPack({ ...input, byteBudget: 200 }))).toHaveLength(1);
  });

  it('counts long escaped source citations and skips an envelope that cannot fit', () => {
    const jobId = '"🌍\n'.repeat(100);
    expect(buildNodeContextPack({
      node: { jobId: 'target', upstreamJobIds: [jobId] },
      outputs: [{ jobId, text: 'data' }], tasks: [], byteBudget: 100,
    })).toBe('');
  });

  it('handles invalid, fractional, empty and exact-fit budgets', () => {
    for (const byteBudget of [-1, NaN, Infinity, -Infinity, 0, 0.9]) {
      expect(buildNodeContextPack({ ...fixture, byteBudget })).toBe('');
    }
    const pack = buildNodeContextPack(fixture);
    expect(buildNodeContextPack({ ...fixture, byteBudget: Buffer.byteLength(pack) + 0.9 })).toBe(pack);
    expect(buildNodeContextPack({ ...fixture, tasks: [], outputs: [] })).toBe('');
  });

  it('uses only relevant unrelated records and preserves frozen inputs deterministically', () => {
    const input = structuredClone(fixture);
    for (const row of [...input.tasks, ...input.outputs]) Object.freeze(row);
    Object.freeze(input.tasks);
    Object.freeze(input.outputs);
    Object.freeze(input.node.upstreamJobIds);
    Object.freeze(input.node);
    Object.freeze(input);
    expect(buildNodeContextPack(input)).toBe(buildNodeContextPack(fixture));
    const rows = entries(buildNodeContextPack({ ...input, node: { ...input.node, query: '' } }));
    expect(rows.map(row => row.jobId)).toEqual(['build', 'build', 'review']);
  });

  it('omits blank citations and empty text', () => {
    expect(buildNodeContextPack({ ...fixture, tasks: [], outputs: [
      { jobId: 'build', text: ' ' }, { jobId: '', text: 'routing' },
    ] })).toBe('');
  });
});
