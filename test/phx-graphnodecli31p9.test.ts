import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const node = { id: 'task:fake-123', kind: 'task', label: 'Example', extra: { order: [3, 1, 2] } };
const graph = {
  status: 'ready',
  nodes: [node, { id: '--json', label: 'Option-like' }, { id: 'nodes', label: 'Command-like' }],
  edges: [{ id: 'fake-edge', from: 'task:fake-123', to: 'nodes' }],
  complete: false,
  sources: { fleetJson: { state: 'partial' } },
  issues: [{ code: 'FAKE_PARTIAL_SOURCE', message: 'Fixture incomplete' }],
};

describe('graph node CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(graph);
  });
  afterEach(() => vi.restoreAllMocks());

  function json() {
    expect(output).toHaveBeenCalledOnce();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it.each([['node', 'task:fake-123', '--json'], ['--json', 'node', 'task:fake-123']])(
    'returns an exact opaque node and partial graph metadata for %j', async (...args) => {
      expect(await cmdGraph(args)).toBe(0);
      expect(json()).toEqual({ schemaVersion: 1, command: 'node', status: 'ready', node,
        complete: graph.complete, sources: graph.sources, issues: graph.issues });
      expect(errors).not.toHaveBeenCalled();
      expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('prints the same record and metadata as indented text', async () => {
    expect(await cmdGraph(['node', 'task:fake-123'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('\n  "node": {');
    expect(json()).toEqual({ schemaVersion: 1, command: 'node', status: 'ready', node,
      complete: graph.complete, sources: graph.sources, issues: graph.issues });
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['fake-123', 'task:fake', 'TASK:FAKE-123', 'absent'])(
    'does not match a different ID: %s', async (id) => {
      expect(await cmdGraph(['node', id, '--json'])).toBe(1);
      expect(json()).toEqual({ schemaVersion: 1, command: 'node', status: 'not_found',
        error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Graph node not found.' } });
    },
  );

  it('reports missing nodes on stderr in text mode', async () => {
    expect(await cmdGraph(['node', 'absent'])).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledExactlyOnceWith('graph: Graph node not found.');
  });

  it('accepts option-like IDs after -- and command-like IDs without it', async () => {
    expect(await cmdGraph(['node', '--', '--json', '--json'])).toBe(0);
    expect(json().node).toEqual(graph.nodes[1]);
    output.mockClear();
    expect(await cmdGraph(['node', 'nodes', '--json'])).toBe(0);
    expect(json().node).toEqual(graph.nodes[2]);
  });

  it('reports unavailable without inventing a missing node or completeness', async () => {
    loader.loadGraph.mockResolvedValue({ status: 'unavailable' });
    expect(await cmdGraph(['node', 'absent', '--json'])).toBe(1);
    expect(json()).toEqual({ schemaVersion: 1, command: 'node', status: 'unavailable',
      error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' } });
  });

  it('keeps loader errors private', async () => {
    loader.loadGraph.mockRejectedValue(new Error('private diagnostic sentinel'));
    expect(await cmdGraph(['node', 'task:fake-123', '--json'])).toBe(1);
    expect(json()).toEqual({ schemaVersion: 1, command: 'node', status: 'error',
      error: { code: 'GRAPH_LOAD_FAILED', message: 'Could not load GRAPH-1 graph data.' } });
  });

  it.each([
    ['node'], ['node', '--'], ['node', '--unknown'], ['node', 'a', 'b'],
    ['node', 'a', '--depth', '1'], ['node', 'a', '--direction', 'out'],
    ['node', 'a', '--json', '--json'], ['node', 'a', '--', 'b'],
  ])('rejects malformed args %j before loading', async (...args) => {
    expect(await cmdGraph(args)).toBe(2);
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('documents node help without loading', async () => {
    expect(await cmdGraph(['node', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('phm graph node <node-id>');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it.each(['nodes', 'edges', 'status', 'neighbors'])('preserves the %s command', async (command) => {
    expect(await cmdGraph(command === 'neighbors'
      ? [command, 'task:fake-123', '--json'] : [command, '--json'])).toBe(0);
    expect(json()).toMatchObject({ schemaVersion: 1, command, status: 'ready' });
  });
});
