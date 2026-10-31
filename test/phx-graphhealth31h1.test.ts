import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';

vi.mock('../src/core/fleet/graph-seed.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/graph-seed.js')>(),
  seedFleetGraph: vi.fn(),
}));
import { seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { cmdGraph } from '../src/cli/graph.js';

const commands = [
  ['status'], ['nodes'], ['edges'], ['neighbors', 'fleet:root'],
] as const;
const reader = vi.mocked(seedFleetGraph);

describe('graph completeness in the CLI', () => {
  let output: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reader.mockReset();
    output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function query(args: readonly string[], exit = 0) {
    expect(await cmdGraph([...args, '--json'])).toBe(exit);
    expect(output).toHaveBeenCalledOnce();
    return JSON.parse(output.mock.calls[0]![0] as string);
  }

  it.each(commands)('reports incomplete evidence in %j without exposing rejected records', async (...args) => {
    const seed = buildFleetGraphSeed({ seats: [
      { id: 'fixture', engine: 'codex' },
      { id: 'rejected', engine: 'codex', env: { PRIVATE: 'PRIVATE_SENTINEL' } },
    ] });
    reader.mockResolvedValue(seed);
    const result = await query(args);
    expect(result).toMatchObject({ status: 'ready', complete: false,
      sources: { fleetJson: { state: 'absent' }, seats: { state: 'loaded' } }, issues: seed.issues });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SENTINEL|seat:rejected/);
    if (args[0] === 'status') expect(result.counts).toEqual({ nodes: seed.nodes.length, edges: seed.edges.length });
    if (args[0] === 'nodes') expect(result.nodes).toEqual(seed.nodes);
    if (args[0] === 'edges') expect(result.edges).toEqual(seed.edges);
    if (args[0] === 'neighbors') expect(result).toMatchObject({ nodeId: 'fleet:root', truncated: false });
  });

  it.each(commands)('reports a complete empty inventory in %j', async (...args) => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [], holds: [] }, seats: [] });
    reader.mockResolvedValue(seed);
    const result = await query(args);
    expect(result).toMatchObject({ status: 'ready', complete: true,
      sources: { fleetJson: { state: 'loaded' }, seats: { state: 'loaded', count: 0 } }, issues: [] });
    if (args[0] === 'status') expect(result.counts).toEqual({ nodes: 1, edges: 0 });
    if (args[0] === 'nodes' || args[0] === 'neighbors') expect(result.nodes).toEqual(seed.nodes);
    if (args[0] === 'edges' || args[0] === 'neighbors') expect(result.edges).toEqual([]);
  });

  it.each(commands)('reports unavailable evidence in %j without invented metadata', async (...args) => {
    reader.mockResolvedValue(buildFleetGraphSeed());
    const result = await query(args, 1);
    expect(result).toEqual({ schemaVersion: 1, command: args[0], status: 'unavailable',
      error: { code: 'GRAPH_UNAVAILABLE', message: 'GRAPH-1 loader is not available in this build.' } });
  });

  it('preserves the not-found response for a missing neighbor', async () => {
    reader.mockResolvedValue(buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [], holds: [] }, seats: [] }));
    expect(await query(['neighbors', 'missing'], 1)).toEqual({ schemaVersion: 1, command: 'neighbors',
      status: 'not_found', error: { code: 'GRAPH_NODE_NOT_FOUND', message: 'Graph node not found.' } });
  });

  it('preserves human neighborhood output without metadata', async () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [], holds: [] }, seats: [] });
    reader.mockResolvedValue(seed);
    expect(await cmdGraph(['neighbors', 'fleet:root'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ schemaVersion: 1, command: 'neighbors',
      status: 'ready', nodeId: 'fleet:root', direction: 'both', depth: 1, truncated: false,
      nodes: seed.nodes, edges: [] });
  });
});
