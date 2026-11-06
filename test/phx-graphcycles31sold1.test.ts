import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetGraphSeed, type FleetGraphSeedV1 } from '../src/core/fleet/graph-seed.js';

// Keep the real GRAPH-1 loader; inject its source because today's inventory seed
// does not yet produce agent nodes or can-delegate edges.
vi.mock('../src/core/fleet/graph-seed.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/graph-seed.js')>(),
  seedFleetGraph: vi.fn(),
}));
import { seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { cmdGraph } from '../src/cli/graph.js';

const reader = vi.mocked(seedFleetGraph);
const edge = (id: string, from: string, to: string, kind = 'can-delegate') => ({ id, from, to, kind });

function fixture(): FleetGraphSeedV1 {
  const base = buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [] }, seats: [] });
  return { ...base,
    nodes: ['z', 'c', 'b', 'a', 'd', 'e', 'f', 'g'].map(id => ({ id, kind: 'agent' })),
    edges: [edge('ca', 'c', 'a'), edge('bc', 'b', 'c'), edge('ab', 'a', 'b'),
      edge('self', 'z', 'z'), edge('de', 'd', 'e'), edge('df', 'd', 'f'),
      edge('eg', 'e', 'g'), edge('fg', 'f', 'g'), edge('review', 'g', 'd', 'reviews')],
  } as unknown as FleetGraphSeedV1;
}

describe('graph cycles CLI with GRAPH-1 loader', () => {
  let output: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reader.mockReset();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function json(expectedExit = 0) {
    expect(await cmdGraph(['cycles', '--json'])).toBe(expectedExit);
    expect(output).toHaveBeenCalledOnce();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it('reports sorted cyclic components and their directed edge evidence, without changing the seed', async () => {
    const seed = fixture();
    const before = structuredClone(seed);
    reader.mockResolvedValue(seed);
    const result = await json();
    expect(result).toEqual({ schemaVersion: 1, command: 'cycles', status: 'ready',
      components: [
        { nodeIds: ['a', 'b', 'c'], edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')] },
        { nodeIds: ['z'], edges: [edge('self', 'z', 'z')] },
      ], acyclic: false, delegationCoverage: 'unknown', complete: true,
      sources: seed.sources, issues: [] });
    expect(seed).toEqual(before);
    output.mockClear();
    reader.mockResolvedValue({ ...seed, nodes: [...seed.nodes].reverse(), edges: [...seed.edges].reverse() });
    expect(await json()).toEqual(result);
  });

  it('explains the agents and edges in text output', async () => {
    reader.mockResolvedValue(fixture());
    expect(await cmdGraph(['cycles'])).toBe(0);
    const text = output.mock.calls.map(call => call[0]).join('\n');
    expect(text).toContain('Agents that may deadlock through delegation: a, b, c');
    expect(text).toContain('a -> b (ab)');
    expect(text).toContain('Agents that may deadlock through delegation: z');
    expect(text).toContain('empty result cannot prove acyclicity');
  });

  it('does not infer acyclicity from a complete inventory without delegation coverage', async () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [] }, seats: [] });
    reader.mockResolvedValue(seed);
    expect(await json()).toMatchObject({ status: 'ready', components: [], acyclic: null,
      complete: true, delegationCoverage: 'unknown', issues: [] });
  });

  it('retains partial source evidence and does not claim an empty graph is acyclic', async () => {
    const seed = buildFleetGraphSeed({ seats: [{ id: 'fixture', engine: 'codex' },
      { id: 'rejected', engine: 'codex', env: { PRIVATE: 'SENTINEL' } }] });
    reader.mockResolvedValue(seed);
    const result = await json();
    expect(result).toMatchObject({ status: 'ready', components: [], acyclic: null, complete: false,
      sources: seed.sources, issues: seed.issues });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('reports an unavailable graph without claiming a result', async () => {
    reader.mockResolvedValue(buildFleetGraphSeed());
    expect(await json(1)).toMatchObject({ status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' } });
  });

  it('rejects malformed delegation evidence and invalid arguments', async () => {
    const seed = fixture();
    reader.mockResolvedValue({ ...seed, edges: [edge('bad', 'a', 'missing')] } as unknown as FleetGraphSeedV1);
    expect(await json(1)).toMatchObject({ status: 'error', error: { code: 'GRAPH_LOAD_FAILED' } });
    output.mockClear();
    expect(await cmdGraph(['cycles', '--kind', 'can-delegate', '--json'])).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ error: { code: 'GRAPH_USAGE' } });
    expect(errors).not.toHaveBeenCalled();
  });
});
