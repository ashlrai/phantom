import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGraphDelegationPath } from '../examples/agents/graph-delegation-path.js';
import { loadGraph, type GraphLoadResult, type GraphSnapshot } from '../src/core/graph/loader.js';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';

const graph: GraphSnapshot = {
  status: 'ready', complete: false,
  sources: { fleetJson: { state: 'loaded', path: null }, seats: { state: 'absent', count: 0 } },
  issues: [{ code: 'unresolved-edge', message: 'Fixture incomplete.', nodeIds: [] }],
  nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })),
  edges: [
    { id: 'ab', from: 'a', to: 'b', kind: 'can-delegate' },
    { id: 'ac', from: 'a', to: 'c', kind: 'can-delegate' },
    { id: 'ba', from: 'b', to: 'a', kind: 'can-delegate' },
    { id: 'bd', from: 'b', to: 'd', kind: 'can-delegate' },
    { id: 'cd', from: 'c', to: 'd', kind: 'can-delegate' },
    { id: 'de', from: 'd', to: 'e', kind: 'can-delegate' },
    { id: 'ce', from: 'c', to: 'e', kind: 'can-delegate' },
    { id: 'ae-review', from: 'a', to: 'e', kind: 'reviews' },
  ],
};

async function run(args: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const lines: string[] = [];
  const exit = await runGraphDelegationPath(args, { load, write: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { exit, result: JSON.parse(lines[0]!) };
}
const args = (from: string, to: string) => ['--from', from, '--to', to];

describe('graph delegation path example', () => {
  it('finds a direct path and returns incomplete source provenance', async () => {
    expect(await run(args('a', 'b'))).toEqual({ exit: 0, result: {
      schemaVersion: 1, status: 'ready', from: 'a', to: 'b', nodeIds: ['a', 'b'], edgeIds: ['ab'],
      complete: false, sources: graph.sources, issues: graph.issues,
    } });
  });

  it('terminates on cycles and selects shortest paths in original edge order', async () => {
    const before = structuredClone(graph);
    expect((await run(args('a', 'd'))).result).toMatchObject({ nodeIds: ['a', 'b', 'd'], edgeIds: ['ab', 'bd'] });
    expect((await run(args('a', 'e'))).result).toMatchObject({ nodeIds: ['a', 'c', 'e'], edgeIds: ['ac', 'ce'] });
    expect((await run(args('b', 'e'))).result).toMatchObject({ nodeIds: ['b', 'd', 'e'], edgeIds: ['bd', 'de'] });
    expect((await run(args('a', 'a'))).result).toMatchObject({ nodeIds: ['a'], edgeIds: [] });
    expect(graph).toEqual(before);
  });

  it('does not reverse edges or follow other relationship kinds', async () => {
    const reverseOnly: GraphSnapshot = { status: 'ready', nodes: [{ id: 'a' }, { id: 'b' }], edges: [
      { id: 'ba', from: 'b', to: 'a', kind: 'can-delegate' },
      { id: 'ab', from: 'a', to: 'b', kind: 'can-message' },
    ] };
    expect(await run(args('a', 'b'), async () => reverseOnly)).toMatchObject({ exit: 1, result: {
      status: 'no_path', complete: null, sources: null, issues: null, error: { code: 'GRAPH_NO_PATH' },
    } });
  });

  it('searches up to the existing graph size without a smaller fixed traversal limit', async () => {
    const nodes = Array.from({ length: 510 }, (_, i) => ({ id: String(i) }));
    const edges = nodes.slice(1).map((node, i) => ({ id: `e${i}`, from: String(i), to: node.id, kind: 'can-delegate' }));
    const result = await run(args('0', '509'), async () => ({ status: 'ready', nodes, edges }));
    expect(result.exit).toBe(0);
    expect(result.result.nodeIds).toHaveLength(510);
    expect(result.result.edgeIds).toHaveLength(509);
  });

  it('distinguishes missing nodes, no path and unavailable inventory with provenance where available', async () => {
    expect(await run(args('missing', 'also-missing'))).toMatchObject({ exit: 1, result: {
      status: 'not_found', missingNodeIds: ['missing', 'also-missing'], complete: false,
      sources: graph.sources, issues: graph.issues, error: { code: 'GRAPH_NODE_NOT_FOUND' },
    } });
    expect(await run(args('e', 'a'))).toMatchObject({ exit: 1, result: {
      status: 'no_path', complete: false, sources: graph.sources, issues: graph.issues, error: { code: 'GRAPH_NO_PATH' },
    } });
    expect(await run(args('a', 'b'), () => loadGraph(async () => buildFleetGraphSeed()))).toMatchObject({
      exit: 1, result: { status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } },
    });
  });

  it('suppresses errors and rejects malformed graph data', async () => {
    const failed = await run(args('a', 'b'), async () => { throw new Error('fake-private-detail'); });
    expect(failed).toMatchObject({ exit: 1, result: { status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } } });
    expect(JSON.stringify(failed)).not.toContain('fake-private-detail');
    for (const bad of [
      { ...graph, nodes: [{ id: 'a' }, { id: 'a' }] },
      { ...graph, edges: [{ from: 'a', to: 'b', kind: 'can-delegate' }] },
      { ...graph, edges: [{ from: 1, to: 'b' }] },
    ]) expect((await run(args('a', 'b'), async () => bad)).result.error.code).toBe('GRAPH_LOAD_FAILED');
  });

  it.each([[], ['--from', 'a'], ['--to', 'b'], ['--from', '', '--to', 'b'],
    ['--from', '--to', 'b'], ['--from', 'a', '--to', 'b', '--from', 'c'],
    ['--from', 'a', '--to', 'b', '--extra']].map(input => [input]))('rejects invalid arguments before loading: %j', async input => {
    const load = vi.fn(async () => graph);
    expect(await run(input, load)).toMatchObject({ exit: 2, result: { status: 'error', error: { code: 'GRAPH_USAGE' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it('runs directly and emits JSON usage errors', () => {
    const home = mkdtempSync(join(tmpdir(), 'graph-path-'));
    try {
      const child = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'examples/agents/graph-delegation-path.ts'], {
        encoding: 'utf8', env: { HOME: home, ASHLR_HOME: home, PATH: process.env.PATH },
      });
      expect(child.status).toBe(2);
      expect(JSON.parse(child.stdout)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
      expect(child.stderr).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 20_000);
});
