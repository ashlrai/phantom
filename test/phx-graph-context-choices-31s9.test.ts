import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { loadGraph } from '../src/core/graph/loader.js';

const guide = readFileSync(new URL('../docs/GRAPH-CONTEXT-CHOICES.md', import.meta.url), 'utf8');
const block = (language: string): string => {
  const match = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``).exec(guide);
  if (!match) throw new Error(`Missing ${language} example in graph context guide`);
  return match[1]!;
};
const snapshot = JSON.parse(block('json')) as NodeContextPackInput;

describe('graph context choices guide', () => {
  it('builds the documented cited upstream output and own-task JSONL', () => {
    const pack = buildNodeContextPack(snapshot);
    expect(pack).toBe(block('jsonl'));
    expect(pack.trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
      { jobId: 'build', kind: 'output', text: 'Built routing fix.', truncated: false },
      { jobId: 'build', kind: 'task', text: 'Implement routing.', truncated: false },
      { jobId: 'review', kind: 'task', text: 'Review routing.', truncated: false },
    ]);
  });

  it('keeps actual fleet inventory separate from explicit upstream job context', async () => {
    const seed = buildFleetGraphSeed({
      fleet: { v: 1, repos: [{ repo: 'example/repo' }], lanes: [{ lane: 'codex' }],
        seats: [{ seat: 'fake-seat', lane: 'codex' }],
        holds: [{ repo: 'example/repo', kind: 'owner-hold' }] },
      seats: [{ id: 'fake-seat', engine: 'codex' }],
    }, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const graph = await loadGraph(async () => seed);
    expect(graph.status).toBe('ready');
    if (graph.status !== 'ready') throw new Error('Expected inventory');
    expect(new Set(graph.nodes.map(node => node.kind))).toEqual(new Set(['fleet', 'repo', 'lane', 'seat', 'hold']));
    expect(graph.nodes.some(node => node.kind === 'task' || node.kind === 'output' || node.kind === 'job')).toBe(false);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'seat:fake-seat', to: 'lane:codex', kind: 'binds' }),
      expect.objectContaining({ from: 'seat:fake-seat', to: 'lane:codex', kind: 'serves' }),
    ]));

    const noUpstream = {
      ...snapshot,
      node: { jobId: snapshot.node.jobId, upstreamJobIds: [] },
      outputs: [...snapshot.outputs, { jobId: 'seat:fake-seat', text: 'Seat output.' },
        { jobId: 'lane:codex', text: 'Lane output.' }],
    };
    expect(buildNodeContextPack(noUpstream)).toBe(
      '{"jobId":"review","kind":"task","text":"Review routing.","truncated":false}\n',
    );
    expect(noUpstream.node.upstreamJobIds).toEqual([]);
  });
});
