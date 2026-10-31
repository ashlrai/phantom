import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const graph = {
  status: 'ready',
  nodes: [{ id: 'task:a' }, { id: 'task:b' }, { id: 'task:ab' }, { id: '--json' }, { id: '--to=x' }],
  edges: [
    { id: '1', from: 'task:a', to: 'task:b', kind: 'can-delegate', detail: 'first' },
    { id: '2', from: 'task:a', to: 'task:ab', kind: 'reviews' },
    { id: '3', from: 'task:ab', to: 'task:b', kind: 'reviews' },
    { id: '4', from: 'task:b', to: 'task:a', kind: 'can-message' },
    { id: '5', from: '--json', to: '--to=x', kind: 'reviews' },
    { id: '6', from: 'task:a', to: 'task:b', kind: 'reviews' },
  ],
  complete: false,
  sources: { fleetJson: { state: 'partial' } },
  issues: [{ code: 'FAKE_PARTIAL', message: 'Fixture incomplete' }],
};

describe('graph edge endpoint filters', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(structuredClone(graph));
  });
  afterEach(() => vi.restoreAllMocks());

  async function query(args: string[], exit = 0) {
    expect(await cmdGraph([...args, '--json'])).toBe(exit);
    expect(output).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it.each([
    [['--from', 'task:a'], [graph.edges[0], graph.edges[1], graph.edges[5]], { from: 'task:a' }],
    [['--to', 'task:b'], [graph.edges[0], graph.edges[2], graph.edges[5]], { to: 'task:b' }],
    [['--from', 'task:a', '--to', 'task:b'], [graph.edges[0], graph.edges[5]], { from: 'task:a', to: 'task:b' }],
    [['--to=task:b', '--kind', 'reviews', '--from=task:a'], [graph.edges[5]], { from: 'task:a', to: 'task:b', kind: 'reviews' }],
    [['--from=--json', '--to=--to=x'], [graph.edges[4]], { from: '--json', to: '--to=x' }],
    [['--from', 'task'], [], { from: 'task' }],
    [['--from', 'task:b', '--to', 'task:b'], [], { from: 'task:b', to: 'task:b' }],
  ])('selects exact edges for %j', async (args, edges, filters) => {
    const original = structuredClone(graph);
    loader.loadGraph.mockResolvedValueOnce(original);
    expect(await query(['edges', ...args])).toEqual({
      schemaVersion: 1, command: 'edges', status: 'ready', edges, filters,
      complete: graph.complete, sources: graph.sources, issues: graph.issues,
    });
    expect(original).toEqual(graph);
    expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it('prints the selected edges in text mode', async () => {
    expect(await cmdGraph(['edges', '--to', 'task:a'])).toBe(0);
    expect(output.mock.calls).toEqual([['Graph edges: 1'], [JSON.stringify([graph.edges[3]], null, 2)]]);
  });

  it('keeps an unavailable graph distinct from an empty selection', async () => {
    loader.loadGraph.mockResolvedValueOnce({ status: 'unavailable' });
    expect(await query(['edges', '--from', 'task:a'], 1)).toEqual({
      schemaVersion: 1, command: 'edges', status: 'unavailable',
      error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' },
    });
  });

  it.each([
    ['nodes', '--from', 'task:a'], ['nodes', '--to=task:b'],
    ['status', '--from=task:a'], ['status', '--to', 'task:b'],
    ['node', 'task:a', '--from=task:a'], ['node', 'task:a', '--to', 'task:b'],
    ['neighbors', 'task:a', '--from', 'task:a'], ['neighbors', 'task:a', '--to=task:b'],
    ['edges', '--from'], ['edges', '--to', ''], ['edges', '--from='], ['edges', '--to='],
    ['edges', '--from', '--json'], ['edges', '--to', '--from=task:a'],
    ['edges', '--from', 'task:a', '--from=task:b'], ['edges', '--to=task:a', '--to', 'task:b'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    expect(await query(args, 2)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('documents endpoint filters in help without loading', async () => {
    expect(await cmdGraph(['edges', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('--from=<id>');
    expect(output.mock.calls[0]![0]).toContain('--to=<id>');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });
});
