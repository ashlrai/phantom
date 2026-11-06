import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRegistryGraph, parseFleetGraphSeed, parseRegistrySeats, registryNodeId } from '../src/core/graph/registry.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/graph/${name}.json`, import.meta.url), 'utf8'));
}
const fleet = parseFleetGraphSeed(fixture('fleet'));
const seats = parseRegistrySeats(fixture('seats'));

describe('graph.v1 registry projection', () => {
  it('matches the golden JSON for all node and edge kinds', () => {
    const graph = buildRegistryGraph(fleet, seats);
    expect(graph).toEqual(fixture('graph.v1'));
    expect(new Set(graph.nodes.map(n => n.kind)).size).toBe(4);
    expect(new Set(graph.edges.map(e => e.kind)).size).toBe(4);
  });

  it('is byte-stable across source ordering and repeated relationships without mutating input', () => {
    const reordered = { ...fleet, agents: [...fleet.agents].reverse(), mcp: [...fleet.mcp].reverse(),
      edges: [...fleet.edges].reverse().concat(fleet.edges) };
    const before = JSON.stringify(reordered);
    expect(JSON.stringify(buildRegistryGraph(reordered, [...seats].reverse())))
      .toBe(JSON.stringify(buildRegistryGraph(fleet, seats)));
    expect(JSON.stringify(reordered)).toBe(before);
  });

  it('merges engine/account aliases, retains all seat IDs, and shares only same-engine models', () => {
    const graph = buildRegistryGraph(fleet, [...seats, { ...seats[0]!, id: 'alias' }]);
    expect(graph.nodes.find(n => n.id === 'engine-account:codex/work'))
      .toMatchObject({ seatIds: ['alias', 'codex-work'] });
    expect(graph.nodes.filter(n => n.kind === 'model')).toHaveLength(2);
    expect(graph.edges).toEqual(buildRegistryGraph(fleet, seats).edges);
  });

  it('encodes identity components without namespace collisions', () => {
    expect(registryNodeId('model', 'a/b', 'c')).not.toBe(registryNodeId('model', 'a', 'b/c'));
    expect(registryNodeId('model', 'local', 'qwen:tag')).toBe('model:local/qwen%3Atag');
    expect(registryNodeId('agent', 'a%2Fb')).not.toBe(registryNodeId('agent', 'a/b'));
  });

  it('accepts future engine catalogs without changing the Verse engine union', () => {
    const graph = buildRegistryGraph({ schema: 'fleet.v1', agents: [], mcp: [], edges: [] },
      [{ id: 'future-seat', engine: 'future-engine', accountId: 'work', models: [{ id: 'new-model' }] }]);
    expect(graph.complete).toBe(true);
    expect(graph.nodes).toContainEqual({ id: 'model:future-engine/new-model', kind: 'model',
      engine: 'future-engine', modelId: 'new-model' });
  });

  it('keeps healthy empty inventories distinct from invalid sources', () => {
    const empty = { schema: 'fleet.v1', agents: [], mcp: [], edges: [] };
    expect(buildRegistryGraph(empty, [])).toMatchObject({ complete: true, nodes: [], edges: [], issues: [] });
    expect(buildRegistryGraph({}, {})).toMatchObject({ complete: false, nodes: [], edges: [],
      sources: { fleet: 'invalid', seats: 'invalid' } });
  });

  it.each([
    { ...fleet, schema: 'fleet.v2' },
    { ...fleet, agents: [fleet.agents[0], fleet.agents[0]] },
    { ...fleet, agents: [{ id: 'bad\nterminal' }] },
    { ...fleet, agents: [{ id: 'lone', modelId: 'shared' }] },
    { ...fleet, mcp: [{ id: 'locus' }, { id: 'locus' }] },
    { ...fleet, edges: [{ kind: 'executes', from: 'producer', to: 'reviewer' }] },
    { ...fleet, agents: new Array(10_001).fill({ id: 'a' }) },
  ])('withholds malformed fleet input while retaining valid seat nodes', value => {
    const graph = buildRegistryGraph(value, seats);
    expect(graph.sources.fleet).toBe('invalid');
    expect(graph.nodes.some(n => n.kind === 'agent')).toBe(false);
    expect(graph.nodes.some(n => n.kind === 'engine-account')).toBe(true);
  });

  it.each([
    [seats[0], seats[0]],
    [{ ...seats[0], models: [{ id: 'x' }, { id: 'x' }] }],
    [{ ...seats[0], engine: '' }],
    [{ ...seats[0], accountId: null }],
    [{ ...seats[0], models: null }],
  ].map(value => [value]))('withholds malformed seat input without fabricating routes', value => {
    const graph = buildRegistryGraph(fleet, value);
    expect(graph.sources.seats).toBe('invalid');
    expect(graph.nodes.some(n => n.kind === 'engine-account')).toBe(false);
    expect(graph.edges.some(e => e.source === 'seats')).toBe(false);
  });

  it('reports dangling references without emitting dangling edges', () => {
    const graph = buildRegistryGraph({ ...fleet,
      agents: [{ id: 'a', seatId: 'missing', mcpIds: ['missing'] },
        { id: 'b', seatId: 'codex-work', modelId: 'missing' }],
      edges: [{ kind: 'reviews', from: 'a', to: 'missing' }],
    }, seats);
    expect(graph.complete).toBe(false);
    expect(graph.issues.map(i => i.code)).toEqual(['unknown-agent', 'unknown-mcp', 'unknown-model', 'unknown-seat']);
    const ids = new Set(graph.nodes.map(n => n.id));
    expect(graph.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('checks model binding against the selected seat, not another engine catalog', () => {
    const graph = buildRegistryGraph(fleet, [seats[1], { ...seats[0], models: [] }]);
    expect(graph.issues).toContainEqual({ source: 'fleet', code: 'unknown-model' });
    expect(graph.edges.some(e => e.from === 'agent:producer' && e.to.startsWith('model:'))).toBe(false);
  });

  it('drops unrelated private fields from both sources and never infers permissions', () => {
    const marker = 'PRIVATE_TEST_MARKER';
    const graph = buildRegistryGraph({ ...fleet, token: marker,
      agents: fleet.agents.map(a => ({ ...a, env: { token: marker }, notes: marker })), edges: [],
      mcp: [{ id: 'locus', command: marker, args: [marker], env: { token: marker } }],
    }, { seats: seats.map(s => ({ ...s, command: [marker], health: { notes: marker },
      models: s.models.map(m => ({ ...m, label: marker })) })), launches: marker });
    expect(JSON.stringify(graph)).not.toContain(marker);
    expect(graph.edges.every(e => e.kind === 'routes-to')).toBe(true);
  });
});
