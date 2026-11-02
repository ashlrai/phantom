import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const graph = {
  status: 'ready',
  nodes: [
    { id: 'opaque/selected', kind: 'agent', agentId: 'worker:one' },
    { id: 'agent:worker%3Aone', kind: 'agent', agentId: 'other' },
    { id: 'account', kind: 'engine-account' },
    { id: 'model', kind: 'model' },
    { id: 'mcp', kind: 'mcp' },
    { id: 'unrelated-model', kind: 'model' },
    { id: 'impostor', kind: 'model', agentId: 'worker:one' },
  ],
  edges: [
    { id: 'account-route', kind: 'routes-to', from: 'opaque/selected', to: 'account' },
    { id: 'model-route', kind: 'routes-to', from: 'opaque/selected', to: 'model' },
    { id: 'mcp-route', kind: 'routes-to', from: 'opaque/selected', to: 'mcp' },
    { id: 'inbound', kind: 'can-message', from: 'agent:worker%3Aone', to: 'opaque/selected' },
    { id: 'outbound', kind: 'reviews', from: 'opaque/selected', to: 'agent:worker%3Aone' },
    { id: 'incoming-route', kind: 'routes-to', from: 'unrelated-model', to: 'opaque/selected' },
    { id: 'indirect-route', kind: 'routes-to', from: 'account', to: 'unrelated-model' },
    { id: 'other-route', kind: 'routes-to', from: 'agent:worker%3Aone', to: 'unrelated-model' },
  ],
  complete: false,
  sources: { fleetJson: { state: 'partial' } },
  issues: [{ code: 'PARTIAL', message: 'Fixture incomplete' }],
};

describe('graph agent binding queries', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    loader.loadGraph.mockResolvedValue(structuredClone(graph));
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function query(args: string[], exit = 0) {
    expect(await cmdGraph([...args, '--json'])).toBe(exit);
    expect(output).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it('selects only the exact agent and direct outgoing binding nodes, preserving evidence', async () => {
    const result = await query(['nodes', '--agent', 'worker:one']);
    expect(result).toEqual({ schemaVersion: 1, command: 'nodes', status: 'ready',
      nodes: [graph.nodes[0], graph.nodes[2], graph.nodes[3], graph.nodes[4]],
      filters: { agent: 'worker:one' }, complete: graph.complete, sources: graph.sources, issues: graph.issues });
  });

  it('selects incoming and outgoing incident edges, not edges of bindings', async () => {
    const result = await query(['edges', '--agent=worker:one']);
    expect(result.edges).toEqual(graph.edges.slice(0, 6));
    expect(result.filters).toEqual({ agent: 'worker:one' });
  });

  it.each([
    [['nodes', '--agent', 'worker:one', '--kind', 'model'], 'nodes', [graph.nodes[3]]],
    [['nodes', '--agent', 'worker:one', '--kind', 'agent'], 'nodes', [graph.nodes[0]]],
    [['edges', '--agent', 'worker:one', '--kind', 'routes-to', '--from', 'opaque/selected', '--to', 'model'], 'edges', [graph.edges[1]]],
    [['edges', '--agent', 'worker:one', '--from', 'account'], 'edges', []],
  ])('intersects filters for %j', async (args, key, records) => {
    const result = await query(args as string[]);
    expect(result[key as string]).toEqual(records);
  });

  it('reports an absent exact agent with partial evidence, without guessing an ID', async () => {
    const result = await query(['nodes', '--agent', 'worker'], 1);
    expect(result).toEqual({ schemaVersion: 1, command: 'nodes', status: 'not_found',
      error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Agent not found in loaded graph.' },
      complete: graph.complete, sources: graph.sources, issues: graph.issues });
  });

  it('refuses ambiguous loaded agent metadata', async () => {
    loader.loadGraph.mockResolvedValue({ ...graph, nodes: [...graph.nodes, { id: 'duplicate', kind: 'agent', agentId: 'worker:one' }] });
    expect(await query(['edges', '--agent', 'worker:one'], 1)).toMatchObject({ error: { code: 'GRAPH_LOAD_FAILED' } });
  });

  it('retains existing unfiltered results and text output', async () => {
    expect(await query(['nodes'])).toMatchObject({ nodes: graph.nodes });
    output.mockClear();
    expect(await cmdGraph(['nodes', '--agent', 'worker:one', '--kind', 'mcp'])).toBe(0);
    expect(output.mock.calls).toEqual([['Graph nodes: 1'], [JSON.stringify([graph.nodes[4]], null, 2)]]);
  });

  it('keeps an unavailable loader distinct from an absent agent', async () => {
    loader.loadGraph.mockResolvedValue({ status: 'unavailable' });
    expect(await query(['nodes', '--agent', 'worker:one'], 1)).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
  });

  it.each([
    ['status', '--agent', 'worker'], ['node', 'x', '--agent', 'worker'],
    ['neighbors', 'x', '--agent=worker'], ['nodes', '--agent'], ['edges', '--agent='],
    ['nodes', '--agent', '--kind', 'agent'], ['edges', '--agent', 'x', '--agent=y'],
    ['--agent', 'worker', 'nodes'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    expect(await query(args, 2)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('describes the selection and partial evidence in help without loading', async () => {
    expect(await cmdGraph(['--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('--agent <bare-agent-id>');
    expect(output.mock.calls[0]![0]).toContain('direct outgoing routes-to targets');
    expect(output.mock.calls[0]![0]).toContain('partial data may omit bindings');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });

  it('is reachable from the public graph parent dispatcher', async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    try {
      process.argv = ['node', 'phm', 'graph', 'nodes', '--agent', 'worker:one', '--json'];
      await import('../src/cli/index.js');
      expect(process.exitCode).toBe(0);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0]![0] as string).nodes).toEqual([graph.nodes[0], graph.nodes[2], graph.nodes[3], graph.nodes[4]]);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  }, 30_000);
});
