import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetGraphSeed } from '../src/core/fleet/graph-seed.js';

vi.mock('../src/core/fleet/graph-seed.js', async (original) => ({
  ...await original<typeof import('../src/core/fleet/graph-seed.js')>(),
  seedFleetGraph: vi.fn(),
}));
import { seedFleetGraph } from '../src/core/fleet/graph-seed.js';
import { loadGraph } from '../src/core/graph/loader.js';
import { cmdGraph } from '../src/cli/graph.js';

const reader = vi.mocked(seedFleetGraph);
const commands = ['nodes', 'edges', 'status'] as const;
function fixture() {
  return buildFleetGraphSeed({
    fleet: { v: 1, repos: [{ repo: 'ashlrai/phantom' }], lanes: [{ lane: 'codex' }],
      seats: [{ seat: 'fixture', lane: 'codex' }] },
    seats: [{ id: 'fixture', engine: 'codex', command: 'PRIVATE_LAUNCH',
      launches: { argv: ['PRIVATE_ARG'] } }],
  });
}

describe('live fleet graph loader adapter', () => {
  beforeEach(() => reader.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('preserves exact seeded records and public projection', async () => {
    const seed = fixture();
    reader.mockResolvedValue(seed);
    const graph = await loadGraph();
    expect(graph).toEqual({ status: 'ready', nodes: seed.nodes, edges: seed.edges,
      complete: seed.complete, sources: seed.sources, issues: seed.issues });
    expect(reader).toHaveBeenCalledExactlyOnceWith();
    expect(seed.nodes.map(({ id }) => id)).toEqual([
      'fleet:root', 'lane:codex', 'repo:ashlrai/phantom', 'seat:fixture',
    ]);
    expect(seed.edges).toHaveLength(4);
    expect(JSON.stringify(graph)).not.toMatch(/PRIVATE_|command|launches|argv/);
  });

  it.each(commands)('returns seeded %s through the existing CLI', async (command) => {
    const seed = fixture();
    reader.mockResolvedValue(seed);
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdGraph([command, '--json'])).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({
      schemaVersion: 1, command, status: 'ready',
      ...(command === 'status' ? { counts: { nodes: seed.nodes.length, edges: seed.edges.length } }
        : { [command]: seed[command] }),
    });
  });

  it.each([undefined, null, { repos: 'invalid' }, { repos: [{ env: { PRIVATE: 'VALUE' } }] }])(
    'refuses missing or wholly unusable inventory %j', async (fleet) => {
      reader.mockResolvedValue(buildFleetGraphSeed({ fleet, seats: [] }));
      expect(await loadGraph()).toEqual({ status: 'unavailable' });
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await cmdGraph(['status', '--json'])).toBe(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
        status: 'unavailable', error: { code: 'GRAPH_UNAVAILABLE' },
      });
    },
  );

  it('keeps valid empty inventory ready, including the seeded root', async () => {
    const seed = buildFleetGraphSeed({ fleet: { v: 1, repos: [], lanes: [], seats: [], holds: [] }, seats: [] });
    reader.mockResolvedValue(seed);
    expect(await loadGraph()).toMatchObject({ status: 'ready', nodes: seed.nodes, edges: [], complete: true });
  });

  it('retains incomplete evidence metadata with usable public records', async () => {
    const seed = buildFleetGraphSeed({ seats: [{ id: 'public', engine: 'codex' },
      { id: 'private', engine: 'codex', env: { PRIVATE: 'VALUE' } }] });
    reader.mockResolvedValue(seed);
    const graph = await loadGraph();
    expect(graph).toMatchObject({ status: 'ready', complete: false, sources: seed.sources, issues: seed.issues });
    expect(JSON.stringify(graph)).not.toMatch(/VALUE|seat:private/);
  });

  it('treats a throwing reader as unavailable without leaking diagnostics', async () => {
    expect(await loadGraph(() => { throw new Error('PRIVATE_READER_DETAIL'); }))
      .toEqual({ status: 'unavailable' });
    expect(await loadGraph(async () => { throw new Error('PRIVATE_READER_DETAIL'); }))
      .toEqual({ status: 'unavailable' });
  });
});
