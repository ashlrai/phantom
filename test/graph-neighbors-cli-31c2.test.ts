import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../src/core/graph/loader.js';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const snapshot = (ids: string[], links: [string, string][]): GraphSnapshot => ({
  status: 'ready', nodes: ids.map((id) => ({ id, label: `node ${id}` })),
  edges: links.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
});
const graph = snapshot(['a', 'b', 'c', 'd', 'e', 'z'], [
  ['a', 'c'], ['a', 'b'], ['b', 'd'], ['c', 'd'], ['d', 'a'], ['d', 'e'],
]);

describe('graph neighbors CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(graph);
  });
  afterEach(() => vi.restoreAllMocks());

  async function query(args: string[], exit = 0) {
    expect(await cmdGraph([...args, '--json'])).toBe(exit);
    expect(output).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it('defaults to both directions and depth 1, returning induced edges and complete records', async () => {
    const result = await query(['neighbors', 'a']);
    expect(result).toEqual({ schemaVersion: 1, command: 'neighbors', status: 'ready', nodeId: 'a',
      direction: 'both', depth: 1, truncated: false,
      nodes: [graph.nodes[0], graph.nodes[1], graph.nodes[2], graph.nodes[3]],
      edges: [graph.edges[1], graph.edges[0], graph.edges[2], graph.edges[3], graph.edges[4]] });
    expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    ['out', 1, ['a', 'b', 'c']],
    ['out', 2, ['a', 'b', 'c', 'd']],
    ['out', 3, ['a', 'b', 'c', 'd', 'e']],
    ['in', 1, ['a', 'd']],
    ['in', 2, ['a', 'd', 'b', 'c']],
    ['both', 2, ['a', 'b', 'c', 'd', 'e']],
  ])('traverses %s at depth %i through a diamond and cycle', async (direction, depth, expected) => {
    const result = await query(['neighbors', 'a', '--direction', direction as string, '--depth', String(depth)]);
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(expected);
    expect(result.edges.every((edge: { from: string; to: string }) =>
      (expected as string[]).includes(edge.from) && (expected as string[]).includes(edge.to))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('stops at depth four in a chain even when more nodes are reachable', async () => {
    loader.loadGraph.mockResolvedValue(snapshot(['0', '1', '2', '3', '4', '5'],
      [['0', '1'], ['1', '2'], ['2', '3'], ['3', '4'], ['4', '5']]));
    const result = await query(['neighbors', '0', '--direction', 'out', '--depth', '4']);
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(result.edges).toHaveLength(4);
    expect(result.truncated).toBe(false);
  });

  it('uses exact opaque identifiers and permits option-like IDs after --', async () => {
    loader.loadGraph.mockResolvedValue(snapshot(['node:x', 'x', '--json', 'nodes'], [['node:x', 'x']]));
    const result = await query(['neighbors', '--', '--json']);
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(['--json']);
    expect(result.nodeId).toBe('--json');
  });

  it('does not infer a missing node from partial matches or dangling edges', async () => {
    loader.loadGraph.mockResolvedValue(snapshot(['node:x'], [['node:x', 'x']]));
    expect(await query(['neighbors', 'x'], 1)).toEqual({ schemaVersion: 1, command: 'neighbors',
      status: 'not_found', error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Graph node not found.' } });
  });

  it('caps nodes deterministically, includes only edges between them, and exposes truncation', async () => {
    const ids = Array.from({ length: 502 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const links: [string, string][] = ids.slice(1).reverse().map((id) => [ids[0]!, id]);
    loader.loadGraph.mockResolvedValue(snapshot(ids.slice().reverse(), links));
    const result = await query(['neighbors', ids[0]!, '--direction', 'out']);
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(ids.slice(0, 500));
    expect(result.edges).toHaveLength(499);
    expect(result.edges.every((edge: { to: string }) => ids.slice(0, 500).includes(edge.to))).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('does not mark an exactly full or depth-limited neighborhood truncated', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const links: [string, string][] = ids.slice(1, 500).map((id) => [ids[0]!, id]);
    links.push([ids[1]!, ids[500]!]);
    loader.loadGraph.mockResolvedValue(snapshot(ids, links));
    const result = await query(['neighbors', ids[0]!, '--direction', 'out']);
    expect(result.nodes).toHaveLength(500);
    expect(result.truncated).toBe(false);
  });

  it('preserves unavailable and loader failure semantics without leaking diagnostics', async () => {
    loader.loadGraph.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await query(['neighbors', 'a'], 1)).toEqual({ schemaVersion: 1, command: 'neighbors',
      status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' } });
    output.mockClear();
    loader.loadGraph.mockRejectedValueOnce(new Error('private diagnostic sentinel'));
    expect(await query(['neighbors', 'a'], 1)).toMatchObject({ status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } });
    expect(output.mock.calls[0]![0]).not.toContain('private diagnostic sentinel');
  });

  it.each([
    ['neighbors'], ['neighbors', 'a', '--depth', '0'], ['neighbors', 'a', '--depth', '5'],
    ['neighbors', 'a', '--depth', '1.0'], ['neighbors', 'a', '--depth'],
    ['neighbors', 'a', '--direction', 'up'], ['neighbors', 'a', '--direction'],
    ['neighbors', 'a', '--depth', '1', '--depth', '2'],
    ['neighbors', 'a', '--direction', 'in', '--direction', 'out'],
    ['neighbors', 'a', 'b'], ['nodes', '--depth', '1'],
  ])('rejects invalid arguments %j without loading', async (...args) => {
    expect(await query(args, 2)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('documents neighbors in graph help without loading', async () => {
    expect(await cmdGraph(['neighbors', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('phm graph neighbors <node-id>');
    expect(output.mock.calls[0]![0]).toContain('500 nodes');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });
});
