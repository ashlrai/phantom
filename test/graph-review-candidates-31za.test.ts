import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runGraphReviewCandidates } from '../examples/agents/graph-review-candidates.js';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';
import { loadGraph, type GraphLoadResult, type GraphSnapshot } from '../src/core/graph/loader.js';

const graph: GraphSnapshot = {
  status: 'ready', complete: false,
  sources: { fleetJson: { state: 'loaded', path: null }, seats: { state: 'absent', count: 0 } },
  issues: [{ code: 'unresolved-edge', message: 'Missing relationship.', nodeIds: [] }],
  nodes: [
    { id: 'agent:target', kind: 'agent' }, { id: 'agent:alice', kind: 'agent' },
    { id: 'agent:bob', kind: 'agent' }, { id: 'agent:empty', kind: 'agent' },
    { id: 'seat:other', kind: 'seat' },
  ],
  edges: [
    { id: 'b1', kind: 'reviews', from: 'agent:bob', to: 'agent:target' },
    { id: 'a1', kind: 'reviews', from: 'agent:alice', to: 'agent:target' },
    { id: 'b2', kind: 'reviews', from: 'agent:bob', to: 'agent:target' },
    { id: 'b2', kind: 'reviews', from: 'agent:bob', to: 'agent:target' },
    { id: 'dangling', kind: 'reviews', from: 'agent:missing', to: 'agent:target' },
    { id: 'seat', kind: 'reviews', from: 'seat:other', to: 'agent:target' },
    { id: 'reverse', kind: 'reviews', from: 'agent:target', to: 'agent:empty' },
    { id: 'message', kind: 'can-message', from: 'agent:empty', to: 'agent:target' },
    { id: 'delegate', kind: 'can-delegate', from: 'agent:empty', to: 'agent:target' },
  ],
};

async function query(args: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const lines: string[] = [];
  const exit = await runGraphReviewCandidates(args, { load, write: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { exit, result: JSON.parse(lines[0]!) };
}

describe('graph review candidates example', () => {
  it('returns distinct agent reviewers and supporting edge IDs in graph order with source health', async () => {
    expect(await query(['--agent', 'agent:target'])).toEqual({ exit: 0, result: {
      schemaVersion: 1, status: 'ready', agentId: 'agent:target', complete: false,
      sources: graph.sources, issues: graph.issues,
      reviewers: [{ reviewerId: 'agent:bob', edgeIds: ['b1', 'b2'] },
        { reviewerId: 'agent:alice', edgeIds: ['a1'] }],
    } });
  });

  it('distinguishes an agent with no reviewers from an absent or non-agent target', async () => {
    expect(await query(['--agent', 'agent:alice'])).toMatchObject({ exit: 0, result: {
      status: 'ready', agentId: 'agent:alice', reviewers: [], complete: false,
    } });
    for (const id of ['agent:missing', 'seat:other']) {
      expect(await query(['--agent', id])).toMatchObject({ exit: 1, result: {
        status: 'not_found', agentId: id, complete: false, sources: graph.sources, issues: graph.issues,
        error: { code: 'GRAPH_NODE_NOT_FOUND' },
      } });
    }
    expect(await query(['--agent', 'agent:empty'])).toMatchObject({ result: {
      reviewers: [{ reviewerId: 'agent:target', edgeIds: ['reverse'] }],
    } });
  });

  it('reports unavailable, missing health, malformed snapshots and private load failures', async () => {
    expect(await query(['--agent', 'agent:target'], async () => ({ status: 'unavailable' }))).toMatchObject({
      exit: 1, result: { status: 'unavailable', agentId: 'agent:target', error: { code: 'GRAPH_UNAVAILABLE' } },
    });
    expect(await query(['--agent', 'agent:target'], async () => ({ status: 'ready', nodes: graph.nodes, edges: [] })))
      .toMatchObject({ result: { complete: null, sources: null, issues: null, reviewers: [] } });
    for (const invalid of [
      { ...graph, nodes: [graph.nodes[0]!, graph.nodes[0]!] },
      { ...graph, edges: [{ kind: 'reviews', from: 'agent:bob', to: 'agent:target' }] },
    ]) {
      expect(await query(['--agent', 'agent:target'], async () => invalid)).toMatchObject({
        exit: 1, result: { error: { code: 'GRAPH_LOAD_FAILED' } },
      });
    }
    const failure = await query(['--agent', 'agent:target'], async () => { throw new Error('fake private detail'); });
    expect(failure).toMatchObject({ exit: 1, result: { error: { code: 'GRAPH_LOAD_FAILED' } } });
    expect(JSON.stringify(failure)).not.toContain('fake private detail');
  });

  it.each([[], ['--agent'], ['--agent', ''], ['--agent', '--other'], ['--agent', 'a', '--agent', 'b'],
    ['--node', 'a'], ['--agent', 'a', '--extra']])('rejects invalid arguments %j without loading', async (...args) => {
    const load = vi.fn(async () => graph);
    expect(await query(args, load)).toMatchObject({ exit: 2, result: { error: { code: 'GRAPH_USAGE' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it('uses the real loader and reports the current inventory projection honestly', async () => {
    const seed = buildFleetGraphSeed({ fleet: { repos: [{ repo: 'example/fake' }] }, seats: [] });
    const result = await query(['--agent', 'agent:target'], () => loadGraph(async () => seed));
    expect(result).toMatchObject({ exit: 1, result: { status: 'not_found', complete: true,
      sources: seed.sources, issues: [], error: { code: 'GRAPH_NODE_NOT_FOUND' } } });
  });

  it('runs directly and emits JSON usage without loading inventory', () => {
    const child = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs',
      'examples/agents/graph-review-candidates.ts'], { encoding: 'utf8' });
    expect(child.status).toBe(2);
    expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
  }, 20_000);
});
