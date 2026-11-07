import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRegistryGraph } from '../src/core/graph/registry.js';

const loader = vi.hoisted(() => ({ loadGraph: vi.fn() }));
vi.mock('../src/core/graph/loader.js', () => loader);
import { cmdGraph } from '../src/cli/graph.js';

describe('registry graph through the CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('exposes declared cross-provider relationships and unresolved references to an agent', async () => {
    const graph = buildRegistryGraph({
      schema: 'fleet.v1',
      agents: [
        { id: 'planner/lead', seatId: 'atlas-seat', modelId: 'model/shared' },
        { id: 'worker:one', seatId: 'nova-seat', modelId: 'model/shared' },
        { id: 'reviewer', seatId: 'nova-seat' },
        { id: 'unassigned', seatId: 'missing-seat', modelId: 'model/phantom' },
      ],
      mcp: [],
      edges: [
        { kind: 'can-delegate', from: 'planner/lead', to: 'worker:one' },
        { kind: 'reviews', from: 'reviewer', to: 'planner/lead' },
        { kind: 'can-delegate', from: 'unassigned', to: 'missing-agent' },
      ],
    }, [
      { id: 'atlas-seat', engine: 'atlas', accountId: 'team/shared', models: [{ id: 'model/shared' }] },
      { id: 'nova-seat', engine: 'nova', accountId: 'team/shared', models: [{ id: 'model/shared' }] },
    ]);
    loader.loadGraph.mockResolvedValue({ status: 'ready', ...graph });
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    async function query(args: string[]) {
      output.mockClear();
      expect(await cmdGraph([...args, '--json'])).toBe(0);
      expect(output).toHaveBeenCalledOnce();
      expect(errors).not.toHaveBeenCalled();
      return JSON.parse(output.mock.calls[0]![0] as string);
    }

    const evidence = {
      status: 'ready', complete: false,
      sources: { fleet: 'loaded', seats: 'loaded' },
      issues: [{ source: 'fleet', code: 'unknown-agent' }, { source: 'fleet', code: 'unknown-seat' }],
    };
    const nodes = await query(['nodes']);
    expect(nodes).toMatchObject(evidence);
    expect(nodes.nodes).toEqual(expect.arrayContaining([
      { id: 'agent:planner%2Flead', kind: 'agent', agentId: 'planner/lead' },
      { id: 'agent:worker%3Aone', kind: 'agent', agentId: 'worker:one' },
      { id: 'engine-account:atlas/team%2Fshared', kind: 'engine-account', engine: 'atlas', accountId: 'team/shared', seatIds: ['atlas-seat'] },
      { id: 'engine-account:nova/team%2Fshared', kind: 'engine-account', engine: 'nova', accountId: 'team/shared', seatIds: ['nova-seat'] },
      { id: 'model:atlas/model%2Fshared', kind: 'model', engine: 'atlas', modelId: 'model/shared' },
      { id: 'model:nova/model%2Fshared', kind: 'model', engine: 'nova', modelId: 'model/shared' },
    ]));
    const ids = nodes.nodes.map((node: { id: string }) => node.id);
    expect(ids).not.toContain('agent:missing-agent');
    expect(ids).not.toContain('model:atlas/model%2Fphantom');
    expect(ids).not.toContain('model:nova/model%2Fphantom');

    const edges = await query(['edges']);
    expect(edges).toMatchObject(evidence);
    expect(edges.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'can-delegate', from: 'agent:planner%2Flead', to: 'agent:worker%3Aone', source: 'fleet' }),
      expect.objectContaining({ kind: 'reviews', from: 'agent:reviewer', to: 'agent:planner%2Flead', source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: 'agent:planner%2Flead', to: 'engine-account:atlas/team%2Fshared', source: 'fleet' }),
      expect.objectContaining({ kind: 'routes-to', from: 'engine-account:nova/team%2Fshared', to: 'model:nova/model%2Fshared', source: 'seats' }),
    ]));
    expect(edges.edges.every((edge: { from: string; to: string }) => ids.includes(edge.from) && ids.includes(edge.to))).toBe(true);
    expect(edges.edges.filter((edge: { from: string }) => edge.from === 'agent:unassigned')).toEqual([]);

    const outgoing = await query(['neighbors', 'agent:planner%2Flead', '--direction', 'out']);
    expect(outgoing).toMatchObject({ ...evidence, nodeId: 'agent:planner%2Flead', direction: 'out', depth: 1, truncated: false });
    expect(outgoing.nodes.map((node: { id: string }) => node.id)).toContain('agent:worker%3Aone');
    expect(outgoing.nodes.map((node: { id: string }) => node.id)).not.toContain('agent:reviewer');
    expect(outgoing.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'can-delegate', from: 'agent:planner%2Flead', to: 'agent:worker%3Aone' }),
    ]));

    const incoming = await query(['neighbors', 'agent:planner%2Flead', '--direction', 'in']);
    expect(incoming).toMatchObject({ ...evidence, direction: 'in', truncated: false });
    expect(incoming.nodes.map((node: { id: string }) => node.id)).toContain('agent:reviewer');
    expect(incoming.nodes.map((node: { id: string }) => node.id)).not.toContain('agent:worker%3Aone');
    expect(incoming.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reviews', from: 'agent:reviewer', to: 'agent:planner%2Flead' }),
    ]));
  });
});
