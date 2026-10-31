import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGraphUpstream } from '../examples/agents/graph-upstream.js';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';
import { loadGraph, type GraphLoadResult, type GraphSnapshot } from '../src/core/graph/loader.js';

const graph: GraphSnapshot = {
  status: 'ready', complete: true,
  nodes: ['root', 'parent', 'ancestor', 'downstream', 'other'].map((id) => ({ id })),
  edges: [
    { from: 'parent', to: 'root' }, { from: 'ancestor', to: 'parent' },
    { from: 'root', to: 'downstream' }, { from: 'root', to: 'parent' },
  ],
};

async function query(args: string[], load: () => Promise<GraphLoadResult> = async () => graph) {
  const lines: string[] = [];
  const exit = await runGraphUpstream(args, { load, write: (line) => lines.push(line) });
  expect(lines).toHaveLength(1);
  return { exit, result: JSON.parse(lines[0]!) };
}

describe('graph upstream example', () => {
  it('walks incoming edges, includes the root and induced cycle edges, and respects depth', async () => {
    const shallow = await query(['--node', 'root']);
    expect(shallow.exit).toBe(0);
    expect(shallow.result).toMatchObject({ schemaVersion: 1, status: 'ready', nodeId: 'root',
      direction: 'in', depth: 1, complete: true, truncated: false });
    expect(shallow.result.nodes.map((node: { id: string }) => node.id)).toEqual(['root', 'parent']);
    expect(shallow.result.edges).toEqual([{ from: 'parent', to: 'root' }, { from: 'root', to: 'parent' }]);
    const deep = await query(['--depth', '4', '--node', 'root']);
    expect(deep.result.nodes.map((node: { id: string }) => node.id)).toEqual(['root', 'parent', 'ancestor']);
    expect(deep.result.edges).toHaveLength(3);
  });

  it('reports the node cap and source completeness independently', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const large: GraphSnapshot = { status: 'ready', complete: false,
      nodes: ids.map((id) => ({ id })), edges: ids.slice(1).map((id) => ({ from: id, to: ids[0] })) };
    const { result } = await query(['--node', ids[0]!, '--depth', '1'], async () => large);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(500);
    expect(result.edges).toHaveLength(499);
    const unknown = await query(['--node', 'root'], async () => ({ ...graph, complete: undefined }));
    expect(unknown.result.complete).toBeNull();
  });

  it('distinguishes missing nodes, unavailable graphs and private read failures', async () => {
    expect(await query(['--node', 'missing'], async () => ({ ...graph, complete: false }))).toMatchObject({
      exit: 1, result: { status: 'not_found', nodeId: 'missing', complete: false, error: { code: 'GRAPH_NODE_NOT_FOUND' } },
    });
    expect(await query(['--node', 'root'], async () => ({ status: 'unavailable' }))).toMatchObject({
      exit: 1, result: { status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } },
    });
    const failed = await query(['--node', 'root'], async () => { throw new Error('private sentinel'); });
    expect(failed).toMatchObject({ exit: 1, result: { status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } } });
    expect(JSON.stringify(failed)).not.toContain('private sentinel');
    const malformed = await query(['--node', 'root'], async () => ({ ...graph, edges: [{ from: 1, to: 'root' }] }));
    expect(malformed).toMatchObject({ exit: 1, result: { status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } } });
  });

  it.each([
    [], ['--node'], ['--node', ''], ['--node', '--depth', '1'], ['--node', 'root', '--depth'],
    ['--node', 'root', '--depth', '0'], ['--node', 'root', '--depth', '5'],
    ['--node', 'root', '--depth', '1.0'], ['--node', 'root', '--depth', '1', '--depth', '2'],
    ['--node', 'root', '--node', 'other'], ['--node', 'root', '--other'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    const load = vi.fn(async () => graph);
    expect(await query(args, load)).toMatchObject({ exit: 2, result: { status: 'error', error: { code: 'GRAPH_USAGE' } } });
    expect(load).not.toHaveBeenCalled();
  });

  it('uses the real loader projection and preserves rejection of secret-bearing records', async () => {
    const seed = buildFleetGraphSeed({ fleet: { repos: [{ repo: 'example/good' },
      { repo: 'example/rejected', token: 'fake-secret' }] }, seats: [] });
    const load = () => loadGraph(async () => seed);
    const { result } = await query(['--node', 'repo:example/good'], load);
    expect(result).toMatchObject({ status: 'ready', complete: false });
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(['repo:example/good', 'fleet:root']);
    expect(JSON.stringify(result)).not.toContain('fake-secret');
    expect((await query(['--node', 'repo:example/rejected'], load)).result.status).toBe('not_found');
  });

  it('runs as a standalone executable and reports invalid usage without reading graph data', () => {
    const home = mkdtempSync(join(tmpdir(), 'graph-upstream-'));
    try {
      let output = '';
      try {
        execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'examples/agents/graph-upstream.ts'],
          { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ASHLR_HOME: join(home, '.ashlr') } });
      } catch (error) {
        const failure = error as { status: number; stdout: string };
        expect(failure.status).toBe(2);
        output = failure.stdout;
      }
      expect(JSON.parse(output)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
