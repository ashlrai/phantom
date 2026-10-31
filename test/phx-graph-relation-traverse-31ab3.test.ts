import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const graph = {
  status: 'ready',
  nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
  edges: [
    { id: 'ab', from: 'a', to: 'b', kind: 'can-delegate' },
    { id: 'bc', from: 'b', to: 'c', kind: 'can-delegate' },
    { id: 'cd', from: 'c', to: 'd', kind: 'can-delegate' },
    { id: 'ad', from: 'a', to: 'd', kind: 'can-message' },
    { id: 'ae', from: 'a', to: 'e', kind: 'reviews' },
    { id: 'ed', from: 'e', to: 'd', kind: 'routes-to' },
  ],
  complete: false,
  sources: { fleetJson: { state: 'partial' }, seats: { state: 'unavailable' } },
  issues: [{ code: 'FAKE_PARTIAL', message: 'Fixture incomplete' }],
};

describe('graph neighbors edge kind', () => {
  let output: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(structuredClone(graph));
  });
  afterEach(() => vi.restoreAllMocks());

  async function query(args: string[], exit = 0) {
    expect(await cmdGraph([...args, '--json'])).toBe(exit);
    expect(output).toHaveBeenCalledOnce();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it.each([
    ['a', 'out', [
      { id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' },
      { id: 'c', distance: 2, predecessor: 'b' }, { id: 'd', distance: 3, predecessor: 'c' },
    ]],
    ['d', 'in', [
      { id: 'd', distance: 0, predecessor: null }, { id: 'c', distance: 1, predecessor: 'd' },
      { id: 'b', distance: 2, predecessor: 'c' }, { id: 'a', distance: 3, predecessor: 'b' },
    ]],
    ['c', 'both', [
      { id: 'c', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'c' },
      { id: 'd', distance: 1, predecessor: 'c' }, { id: 'a', distance: 2, predecessor: 'b' },
    ]],
  ] as const)('traverses only delegation edges from %s in direction %s', async (root, direction, traversal) => {
    const original = structuredClone(graph);
    loader.loadGraph.mockResolvedValueOnce(original);
    const result = await query(['neighbors', root as string, '--direction', direction as string,
      '--depth', '3', '--edge-kind', 'can-delegate']);
    expect(result).toEqual({
      schemaVersion: 1, command: 'neighbors', status: 'ready', nodeId: root, direction, depth: 3,
      truncated: false, nodes: traversal.map(({ id }) => ({ id })), edges: graph.edges.slice(0, 3), traversal,
      edgeKind: 'can-delegate', complete: graph.complete, sources: graph.sources, issues: graph.issues,
    });
    expect(original).toEqual(graph);
  });

  it.each([
    ['can-message', 'a', 'out', ['a', 'd'], ['ad']],
    ['reviews', 'a', 'out', ['a', 'e'], ['ae']],
    ['routes-to', 'd', 'in', ['d', 'e'], ['ed']],
  ])('selects the exact %s kind', async (kind, root, direction, nodes, edges) => {
    const result = await query(['neighbors', root as string, '--direction', direction as string,
      '--depth', '3', '--edge-kind', kind as string]);
    expect(result.edgeKind).toBe(kind);
    expect(result.nodes.map((node: { id: string }) => node.id)).toEqual(nodes);
    expect(result.edges.map((edge: { id: string }) => edge.id)).toEqual(edges);
  });

  it('keeps existing unfiltered output and the shorter messaging path', async () => {
    const result = await query(['neighbors', 'a', '--direction', 'out', '--depth', '3']);
    expect(result).toEqual({
      schemaVersion: 1, command: 'neighbors', status: 'ready', nodeId: 'a', direction: 'out', depth: 3,
      truncated: false, nodes: [graph.nodes[0], graph.nodes[1], graph.nodes[3], graph.nodes[4], graph.nodes[2]],
      edges: [graph.edges[0], graph.edges[3], graph.edges[4],
        graph.edges[1], graph.edges[2], graph.edges[5]],
      traversal: [
        { id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' },
        { id: 'd', distance: 1, predecessor: 'a' }, { id: 'e', distance: 1, predecessor: 'a' },
        { id: 'c', distance: 2, predecessor: 'b' },
      ], complete: graph.complete, sources: graph.sources, issues: graph.issues,
    });
  });

  it('returns the existing missing-root error with a filter', async () => {
    expect(await query(['neighbors', 'missing', '--edge-kind', 'can-delegate'], 1)).toEqual({
      schemaVersion: 1, command: 'neighbors', status: 'not_found',
      error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Graph node not found.' },
    });
  });

  it('includes the filter and source evidence in text output', async () => {
    expect(await cmdGraph(['neighbors', 'a', '--edge-kind', 'can-delegate'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
      edgeKind: 'can-delegate', complete: graph.complete, sources: graph.sources, issues: graph.issues,
      traversal: [{ id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' }],
    });
  });

  it.each([
    ['neighbors', 'a', '--edge-kind'], ['neighbors', 'a', '--edge-kind', ''],
    ['neighbors', 'a', '--edge-kind', 'CAN-DELEGATE'], ['neighbors', 'a', '--edge-kind', 'can-delegate,reviews'],
    ['neighbors', 'a', '--edge-kind', 'can-delegate', '--edge-kind', 'reviews'],
    ['neighbors', 'a', '--kind', 'can-delegate'], ['edges', '--edge-kind', 'can-delegate'],
    ['nodes', '--edge-kind', 'can-delegate'], ['node', 'a', '--edge-kind', 'can-delegate'],
    ['status', '--edge-kind', 'can-delegate'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    expect(await query(args, 2)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('distinguishes the two filters and explains the authority limit in help', async () => {
    expect(await cmdGraph(['--help'])).toBe(0);
    const help = output.mock.calls[0]![0] as string;
    expect(help).toContain('--kind      Filter nodes');
    expect(help).toContain('--edge-kind Filter neighbors traversal');
    expect(help).toContain('does not grant dispatch authority');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });
});
