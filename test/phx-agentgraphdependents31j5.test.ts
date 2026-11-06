import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runGraphDependents } from '../examples/agents/graph-dependents.js';
import { loadGraph, type GraphLoadResult } from '../src/core/graph/loader.js';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';

const args = ['--node', 'a', '--depth', '2'];
const graph: GraphLoadResult = {
  status: 'ready', complete: false,
  sources: { fleetJson: { state: 'loaded', path: null }, seats: { state: 'absent', count: 0 } },
  issues: [{ code: 'unresolved-edge', message: 'Missing relationship.', nodeIds: [] }],
  nodes: ['a', 'b', 'c', 'd', 'outside'].map(id => ({ id })),
  edges: [
    { id: 'ab', from: 'a', to: 'b' }, { id: 'ac', from: 'a', to: 'c' },
    { id: 'bd', from: 'b', to: 'd' }, { id: 'cd', from: 'c', to: 'd' },
    { id: 'da', from: 'd', to: 'a' }, { id: 'oa', from: 'outside', to: 'a' },
  ],
};

async function run(input: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const lines: string[] = [];
  const exit = await runGraphDependents(input, { load, write: line => lines.push(line) });
  return { exit, lines, result: JSON.parse(lines[0]!) as Record<string, unknown> };
}

describe('graph dependents example', () => {
  it('follows outgoing diamond edges once, handles a cycle, and retains completeness metadata', async () => {
    const { exit, lines, result } = await run(args);
    expect(exit).toBe(0);
    expect(lines).toHaveLength(1);
    expect(result).toMatchObject({ schemaVersion: 1, status: 'ready', nodeId: 'a', direction: 'out', depth: 2,
      truncated: false, complete: false, sources: graph.sources, issues: graph.issues });
    expect(result.nodes).toEqual(['a', 'b', 'c', 'd'].map(id => ({ id })));
    expect(result.edges).toEqual(graph.edges.slice(0, 5));
  });

  it('honors depth and reports truncation at the reader limit', async () => {
    const shallow = await run(['--depth', '1', '--node', 'a']);
    expect(shallow.result.nodes).toEqual(['a', 'b', 'c'].map(id => ({ id })));
    const large: GraphLoadResult = { status: 'ready', nodes: Array.from({ length: 501 }, (_, i) => ({ id: String(i) })),
      edges: Array.from({ length: 500 }, (_, i) => ({ from: '0', to: String(i + 1) })) };
    const bounded = await run(['--node', '0', '--depth', '1'], async () => large);
    expect(bounded.result).toMatchObject({ truncated: true, complete: null, sources: null, issues: null });
    expect(bounded.result.nodes).toHaveLength(500);
  });

  it('reports unavailable inventory using the real loader', async () => {
    const result = await run(args, () => loadGraph(async () => buildFleetGraphSeed()));
    expect(result.exit).toBe(1);
    expect(result.result).toMatchObject({ status: 'error', error: { code: 'GRAPH_UNAVAILABLE' } });
  });

  it('reports missing nodes and suppresses reader and validation exception details', async () => {
    const missing = await run(['--node', 'missing', '--depth', '4']);
    expect(missing.exit).toBe(1);
    expect(missing.result).toMatchObject({ error: { code: 'GRAPH_NODE_NOT_FOUND' } });
    const broken = await run(args, async () => { throw new Error('private-reader-detail'); });
    expect(broken.exit).toBe(1);
    expect(broken.result).toMatchObject({ error: { code: 'GRAPH_LOAD_FAILED' } });
    expect(broken.lines.join()).not.toContain('private-reader-detail');
    const malformed = await run(args, async () => ({ status: 'ready', nodes: [{ id: 'a' }, { id: 'a' }], edges: [] }));
    expect(malformed.result).toMatchObject({ error: { code: 'GRAPH_LOAD_FAILED' } });
  });

  it.each([[], ['--node', 'a'], ['--depth', '1'], ['--node', 'a', '--depth', '0'],
    ['--node', 'a', '--depth', '5'], ['--node', 'a', '--depth', '1.0'],
    ['--node', 'a', '--depth', '1', '--node', 'b'], ['--node', '--depth', '1'],
    ['--node', 'a', '--depth', '1', '--extra']].map(input => [input]))('rejects invalid arguments without loading: %j', async input => {
    let loaded = false;
    const result = await run(input, async () => { loaded = true; return graph; });
    expect(result.exit).toBe(2);
    expect(result.result).toMatchObject({ error: { code: 'GRAPH_USAGE' } });
    expect(loaded).toBe(false);
  });

  it('runs directly and help does not need inventory', () => {
    const home = mkdtempSync(join(tmpdir(), 'graph-dependents-'));
    try {
      const child = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'examples/agents/graph-dependents.ts', '--help'], {
        cwd: process.cwd(), encoding: 'utf8', env: { HOME: home, ASHLR_HOME: home, PATH: process.env.PATH },
      });
      expect(child.status).toBe(0);
      expect(child.stdout).toContain('Usage: npx tsx examples/agents/graph-dependents.ts');
      expect(child.stderr).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
