import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

const graph = {
  status: 'ready',
  nodes: [
    { id: 'fake:agent-1', kind: 'agent', label: 'First', details: { public: true } },
    { id: 'fake:account', kind: 'engine-account' },
    { id: 'fake:model', kind: 'model' },
    { id: 'fake:mcp', kind: 'mcp' },
    { id: 'fake:agent-2', kind: 'agent' },
    { id: 'fake:other', kind: 'agent-extra' },
    { id: 'fake:missing-kind' },
  ],
  edges: [
    { id: 'fake:message-1', kind: 'can-message', from: 'fake:agent-1', to: 'fake:agent-2' },
    { id: 'fake:delegate', kind: 'can-delegate', from: 'fake:agent-2', to: 'fake:agent-1' },
    { id: 'fake:review', kind: 'reviews', from: 'fake:agent-1', to: 'fake:agent-2' },
    { id: 'fake:route', kind: 'routes-to', from: 'fake:agent-1', to: 'fake:model' },
    { id: 'fake:message-2', kind: 'can-message', from: 'fake:agent-2', to: 'fake:agent-1' },
    { id: 'fake:other-edge', kind: 'can-message-extra' },
    { id: 'fake:missing-kind-edge' },
  ],
  complete: false,
  sources: { fleetJson: { state: 'partial' } },
  issues: [{ code: 'FAKE_PARTIAL_SOURCE', message: 'Fixture incomplete' }],
};

const cases = [
  ['nodes', 'agent', [graph.nodes[0], graph.nodes[4]]],
  ['nodes', 'engine-account', [graph.nodes[1]]],
  ['nodes', 'model', [graph.nodes[2]]],
  ['nodes', 'mcp', [graph.nodes[3]]],
  ['edges', 'can-message', [graph.edges[0], graph.edges[4]]],
  ['edges', 'can-delegate', [graph.edges[1]]],
  ['edges', 'reviews', [graph.edges[2]]],
  ['edges', 'routes-to', [graph.edges[3]]],
] as const;

describe('graph CLI kind filters', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    loader.loadGraph.mockResolvedValue(structuredClone(graph));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)('filters %s by exact kind %s in JSON', async (command, kind, expected) => {
    expect(await cmdGraph(['--json', command, '--kind', kind])).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1, command, status: 'ready', [command]: expected,
      complete: graph.complete, sources: graph.sources, issues: graph.issues,
    });
    expect(errors).not.toHaveBeenCalled();
    expect(loader.loadGraph).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(cases)('prints filtered %s by kind %s in text', async (command, kind, expected) => {
    expect(await cmdGraph([command, '--kind', kind])).toBe(0);
    expect(output.mock.calls).toEqual([[`Graph ${command}: ${expected.length}`], [JSON.stringify(expected, null, 2)]]);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(['nodes', 'edges'] as const)('preserves unfiltered %s and source health', async (command) => {
    expect(await cmdGraph([command, '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1, command, status: 'ready', [command]: graph[command],
      complete: graph.complete, sources: graph.sources, issues: graph.issues,
    });
  });

  it.each([['nodes', 'model'], ['edges', 'reviews']] as const)(
    'returns an empty filtered %s with unchanged metadata', async (command, kind) => {
      loader.loadGraph.mockResolvedValue({ ...graph, [command]: [] });
      expect(await cmdGraph([command, '--kind', kind, '--json'])).toBe(0);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
        schemaVersion: 1, command, status: 'ready', [command]: [],
        complete: graph.complete, sources: graph.sources, issues: graph.issues,
      });
    },
  );

  it.each([['nodes', 'agent'], ['edges', 'reviews']] as const)(
    'keeps unavailable %s distinct from an empty result', async (command, kind) => {
      loader.loadGraph.mockResolvedValue({ status: 'unavailable' });
      expect(await cmdGraph([command, '--kind', kind, '--json'])).toBe(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
        schemaVersion: 1, command, status: 'unavailable',
        error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' },
      });
    },
  );

  it.each([
    ['nodes', '--kind'], ['nodes', '--kind', '--json'], ['nodes', '--kind', ''],
    ['nodes', '--kind', 'Agent'], ['nodes', '--kind', 'agents'], ['nodes', '--kind', 'can-message'],
    ['edges', '--kind', 'agent'], ['edges', '--kind', 'routes-to-extra'],
    ['nodes', '--kind', 'agent', '--kind', 'agent'], ['edges', '--kind', 'reviews', '--kind', 'routes-to'],
    ['nodes', '--kind=agent'], ['--kind', 'agent', 'nodes'],
    ['status', '--kind', 'agent'], ['node', 'fake:agent-1', '--kind', 'agent'],
    ['neighbors', 'fake:agent-1', '--kind', 'agent'], ['nodes', '--kind', 'agent', '--json', '--json'],
    ['nodes', '--kind', 'agent', '--help', '--help'],
  ])('rejects invalid arguments %j before loading', async (...args) => {
    expect(await cmdGraph(args)).toBe(2);
    expect(loader.loadGraph).not.toHaveBeenCalled();
    if (args.includes('--json')) {
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ status: 'error', error: { code: 'GRAPH_USAGE' } });
      expect(errors).not.toHaveBeenCalled();
    } else {
      expect(output).not.toHaveBeenCalled();
      expect(errors.mock.calls[0]![0]).toMatch(/^graph: /);
    }
  });

  it('documents both sets of kinds in help without loading', async () => {
    expect(await cmdGraph(['--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('agent|engine-account|model|mcp');
    expect(output.mock.calls[0]![0]).toContain('can-message|can-delegate|reviews|routes-to');
    expect(loader.loadGraph).not.toHaveBeenCalled();
  });
});
