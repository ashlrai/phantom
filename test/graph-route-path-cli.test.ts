import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphSnapshot } from '../src/core/graph/loader.js';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const edge = (id: string, from: string, to: string, kind = 'can-message') =>
  ({ id, from, to, kind, source: 'fixture', evidence: { note: id } });
const snapshot = (ids: string[], edges: ReturnType<typeof edge>[]): GraphSnapshot => ({
  status: 'ready', nodes: ids.map((id) => ({ id })), edges,
});
const graph = snapshot(['a', 'b', 'c', 'd', 'z'], [
  edge('ac', 'a', 'c'), edge('ab2', 'a', 'b'), edge('ab1', 'a', 'b'),
  edge('bd', 'b', 'd'), edge('cd', 'c', 'd'), edge('da', 'd', 'a'),
  edge('delegate', 'a', 'd', 'can-delegate'), edge('dangling', 'a', 'missing'),
  edge('dangling2', 'missing', 'z'),
]);

describe('graph path CLI', () => {
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
    return JSON.parse(output.mock.calls.at(-1)![0] as string);
  }
  const args = (source: string, target: string, kind = 'can-message') =>
    ['path', source, target, '--edge-kind', kind];

  it('chooses a deterministic shortest directed path and preserves full edge evidence without mutation', async () => {
    const original = structuredClone(graph);
    loader.loadGraph.mockResolvedValueOnce(original);
    expect(await query(args('a', 'd'))).toMatchObject({ schemaVersion: 1, command: 'path', status: 'found',
      sourceId: 'a', targetId: 'd', edgeKind: 'can-message', maxHops: 8,
      nodeIds: ['a', 'b', 'd'], edges: [graph.edges[2], graph.edges[3]] });
    expect(original).toEqual(graph);
    expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it('uses only the selected kind and recorded direction', async () => {
    expect(await query(args('a', 'd', 'can-delegate'))).toMatchObject({ nodeIds: ['a', 'd'], edges: [graph.edges[6]] });
    expect(await query(args('d', 'a', 'can-delegate'), 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
    expect(await query(args('a', 'd', 'reviews'), 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
    expect(await query(args('a', 'd', 'routes-to'), 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
  });

  it('distinguishes missing endpoints, same-node paths, and dangling edges', async () => {
    expect(await query(args('a', 'missing'), 1)).toMatchObject({ status: 'not_found', reason: 'missing_endpoint' });
    expect(await query(args('missing', 'missing'), 1)).toMatchObject({ status: 'not_found', reason: 'missing_endpoint' });
    expect(await query(args('a', 'a'))).toMatchObject({ status: 'found', nodeIds: ['a'], edges: [] });
    expect(await query(args('a', 'z'), 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
  });

  it('reports hop-limited unknown only when candidates remain unexplored', async () => {
    expect(await query([...args('a', 'd'), '--max-hops', '1'], 1)).toMatchObject({ status: 'search_limit' });
    loader.loadGraph.mockResolvedValueOnce(snapshot(['a', 'b', 'z'], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a')]));
    expect(await query([...args('a', 'z'), '--max-hops', '1'], 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
    loader.loadGraph.mockResolvedValueOnce(snapshot(['a', 'b', 'c', 'z'], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bc', 'b', 'c')]));
    expect(await query([...args('a', 'z'), '--max-hops', '1'], 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
  });

  it('reports the visit limit only when it prevents exploration', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const links = ids.slice(1).reverse().map((id) => edge(id, ids[0]!, id));
    loader.loadGraph.mockResolvedValueOnce(snapshot([...ids, 'z'], links));
    expect(await query(args(ids[0]!, 'z'), 1)).toMatchObject({ status: 'search_limit' });
    loader.loadGraph.mockResolvedValueOnce(snapshot([...ids.slice(0, 500), 'z'], links.slice(1)));
    expect(await query(args(ids[0]!, 'z'), 1)).toMatchObject({ status: 'not_found', reason: 'exhausted' });
  });

  it('retains partial coverage for all loaded results and explains scope in text', async () => {
    const partial = { ...graph, complete: false, sources: { fixture: 'partial' }, issues: [{ code: 'fixture' }] };
    loader.loadGraph.mockResolvedValue(partial);
    for (const [target, extra, exit, status] of [['d', [], 0, 'found'], ['z', [], 1, 'not_found'],
      ['missing', [], 1, 'not_found'], ['d', ['--max-hops', '1'], 1, 'search_limit']] as const) {
      expect(await query([...args('a', target), ...extra], exit)).toMatchObject({ status, complete: false,
        sources: partial.sources, issues: partial.issues });
    }
    expect(await cmdGraph(args('a', 'z'))).toBe(1);
    expect(output.mock.calls.at(-1)![0]).toContain('No route found in loaded data');
    expect(output.mock.calls.at(-1)![0]).toContain('do not grant dispatch authority');
  });

  it('handles unavailable and failed loaders without exposing private details', async () => {
    loader.loadGraph.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await query(args('a', 'd'), 1)).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
    loader.loadGraph.mockRejectedValueOnce(new Error('private diagnostic sentinel'));
    expect(await query(args('a', 'd'), 1)).toMatchObject({ status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } });
    expect(output.mock.calls.at(-1)![0]).not.toContain('private diagnostic sentinel');
  });

  it.each([
    ['path'], ['path', 'a'], ['path', 'a', 'b'], ['path', 'a', 'b', '--edge-kind', ''],
    ['path', 'a', 'b', '--edge-kind', 'contains'], ['path', 'a', 'b', '--edge-kind', 'can-message', '--edge-kind', 'reviews'],
    ['path', 'a', 'b', 'c', '--edge-kind', 'reviews'], ['path', 'a', 'b', '--edge-kind', 'reviews', '--max-hops', '0'],
    ['path', 'a', 'b', '--edge-kind', 'reviews', '--max-hops', '17'], ['path', 'a', 'b', '--edge-kind', 'reviews', '--max-hops', '1.0'],
    ['path', 'a', 'b', '--edge-kind', 'reviews', '--max-hops', '1', '--max-hops', '2'],
    ['path', 'a', 'b', '--edge-kind', 'reviews', '--json'],
  ])('rejects invalid or duplicate arguments %j before loading', async (...invalid) => {
    expect(await query(invalid, 2)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('documents a runnable example and advisory scope', async () => {
    expect(await cmdGraph(['path', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('phm graph path agent:one agent:two --edge-kind can-message --json');
    expect(output.mock.calls[0]![0]).toContain('advisory only');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });
});
