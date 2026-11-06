import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../src/core/graph/loader.js';
import { graphNeighborhood, type GraphDirection } from '../src/core/graph/neighborhood.js';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const snapshot = (ids: string[], links: [string, string][]): GraphSnapshot => ({
  status: 'ready',
  nodes: ids.map((id) => ({ id, label: `node ${id}` })),
  edges: links.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
});

function expectPaths(graph: GraphSnapshot, direction: GraphDirection, paths: { id: string; distance: number; predecessor: string | null }[]) {
  const byId = new Map(paths.map((path) => [path.id, path]));
  expect(byId.size).toBe(paths.length);
  expect(paths[0]).toMatchObject({ distance: 0, predecessor: null });
  for (const path of paths.slice(1)) {
    expect(path.predecessor).not.toBeNull();
    const parent = byId.get(path.predecessor!);
    expect(parent).toBeDefined();
    expect(parent!.distance).toBe(path.distance - 1);
    expect(graph.edges.some((edge) =>
      (direction !== 'in' && edge.from === parent!.id && edge.to === path.id) ||
      (direction !== 'out' && edge.to === parent!.id && edge.from === path.id))).toBe(true);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('inventory graph neighborhood distances', () => {
  it.each([
    ['out', 'a', [{ id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' },
      { id: 'c', distance: 2, predecessor: 'b' }, { id: 'd', distance: 3, predecessor: 'c' }]],
    ['in', 'd', [{ id: 'd', distance: 0, predecessor: null }, { id: 'c', distance: 1, predecessor: 'd' },
      { id: 'b', distance: 2, predecessor: 'c' }, { id: 'a', distance: 3, predecessor: 'b' }]],
    ['both', 'b', [{ id: 'b', distance: 0, predecessor: null }, { id: 'a', distance: 1, predecessor: 'b' },
      { id: 'c', distance: 1, predecessor: 'b' }, { id: 'd', distance: 2, predecessor: 'c' }]],
  ] as const)('follows a directed chain in %s direction', (direction, root, expected) => {
    const graph = snapshot(['d', 'b', 'a', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    const before = structuredClone(graph);
    const result = graphNeighborhood(graph, root, direction, 3)!;
    expect(result.traversal).toEqual(expected);
    expect(result.nodes.map((node) => node.id)).toEqual(expected.map((path) => path.id));
    expectPaths(graph, direction, result.traversal);
    expect(graph).toEqual(before);
  });

  it('chooses the first shortest path deterministically through a diamond and cycle', () => {
    const graph = snapshot(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'b'], ['b', 'd'], ['d', 'e'], ['a', 'e'],
    ]);
    const expected = [
      { id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' },
      { id: 'c', distance: 1, predecessor: 'a' }, { id: 'e', distance: 1, predecessor: 'a' },
      { id: 'd', distance: 2, predecessor: 'b' },
    ];
    const result = graphNeighborhood(graph, 'a', 'out', 4)!;
    expect(result.traversal).toEqual(expected);
    expect(result.truncated).toBe(false);
    expect(result.edges.map((edge) => edge.id)).toEqual(['a->b', 'a->c', 'a->e', 'b->d', 'c->d', 'd->a', 'd->e']);
    expectPaths(graph, 'out', result.traversal);
    expect(graphNeighborhood({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, 'a', 'out', 4)!.traversal).toEqual(expected);
  });

  it('respects the depth bound and returns null for a missing root', () => {
    const graph = snapshot(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'missing']]);
    const result = graphNeighborhood(graph, 'a', 'out', 1)!;
    expect(result).toMatchObject({ nodeId: 'a', direction: 'out', depth: 1, truncated: false,
      traversal: [{ id: 'a', distance: 0, predecessor: null }, { id: 'b', distance: 1, predecessor: 'a' }] });
    expect(result.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['a->b']);
    expect(graphNeighborhood(graph, 'missing', 'both', 4)).toBeNull();
    expectPaths(graph, 'out', result.traversal);
  });

  it('keeps predecessor evidence within the 500-node cap and reports actual truncation', () => {
    const ids = Array.from({ length: 502 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const graph = snapshot([...ids].reverse(), ids.slice(1).reverse().map((id) => [ids[0]!, id]));
    const before = structuredClone(graph);
    const result = graphNeighborhood(graph, ids[0]!, 'out', 1)!;
    expect(result.truncated).toBe(true);
    expect(result.nodes.map((node) => node.id)).toEqual(ids.slice(0, 500));
    expect(result.traversal).toEqual(ids.slice(0, 500).map((id, i) => ({
      id, distance: i === 0 ? 0 : 1, predecessor: i === 0 ? null : ids[0],
    })));
    expect(result.edges).toHaveLength(499);
    expectPaths(graph, 'out', result.traversal);
    expect(graph).toEqual(before);
    const exact = snapshot(ids.slice(0, 500), ids.slice(1, 500).map((id) => [ids[0]!, id]));
    expect(graphNeighborhood(exact, ids[0]!, 'out', 1)!.truncated).toBe(false);
  });

  it('includes the same evidence in CLI JSON using the existing graph loader', async () => {
    const graph = snapshot(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    loader.loadGraph.mockResolvedValueOnce(graph);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdGraph(['neighbors', 'a', '--direction', 'out', '--depth', '2', '--json'])).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1, command: 'neighbors', status: 'ready',
      ...graphNeighborhood(graph, 'a', 'out', 2),
    });
    expect(loader.loadGraph).toHaveBeenCalledOnce();
  });
});
