import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdGraph } from '../src/cli/graph.js';
import { GRAPH_SOURCE_MAX_BYTES, readRegistryGraph } from '../src/core/graph/status.js';

const native = vi.hoisted(() => ({ root: '', config: vi.fn(), models: vi.fn(), profile: vi.fn(), discover: vi.fn() }));
vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: native.config }));
vi.mock('../src/core/verse/seats.js', () => ({
  resolveAccountsRoot: () => native.root,
  readSeatProfile: native.profile,
  nativeSeatModels: native.models,
  discoverSeats: native.discover,
}));

let root: string;
let fleetPath: string;
let seatsPath: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-graph-'));
  native.root = root;
  native.config.mockReturnValue({});
  native.profile.mockReturnValue(null);
  native.models.mockReturnValue({ models: [{ id: 'catalog-model', unavailableReason: 'old CLI' }], notes: ['fallback'] });
  fleetPath = join(root, 'fleet.json');
  seatsPath = join(root, 'seats.json');
  for (const [path, name] of [[fleetPath, 'fleet'], [seatsPath, 'seats']]) {
    writeFileSync(path!, readFileSync(new URL(`./fixtures/graph/${name}.json`, import.meta.url)), { mode: 0o600 });
  }
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('phm graph status', () => {
  it('prints exactly the golden JSON through the real file reader, without writes', async () => {
    const before = readdirSync(root);
    expect(await cmdGraph(['status', '--fleet', fleetPath, '--seats', seatsPath, '--json'])).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]![0])))
      .toEqual(JSON.parse(readFileSync(new URL('./fixtures/graph/graph.v1.json', import.meta.url), 'utf8')));
    expect(errors).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(before);
    expect(native.config).not.toHaveBeenCalled();
  });

  it('renders the human summary and relationships', async () => {
    expect(await cmdGraph(['status', '--fleet', fleetPath, '--seats', seatsPath])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('7 nodes; 9 edges');
    expect(output.mock.calls[0]![0]).toContain('agent:reviewer --reviews--> agent:producer');
  });

  it.each([
    [], ['--json'], ['run', '--json'], ['status', 'extra', '--json'],
    ['status', '--fleet', '--json'], ['status', '--seats', '', '--json'],
    ['status', '--json', '--json'], ['status', '--fleet', 'a', '--fleet', 'b', '--json'],
    ['status', '--surprise', '--json'], ['status', '--seats', 'bad\npath', '--json'],
  ].map(args => [args]))('rejects invalid arguments before reading sources: %j', async args => {
    expect(await cmdGraph(args)).toBe(2);
    expect(native.config).not.toHaveBeenCalled();
    if (args.includes('--json')) {
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0]![0])).error).toBe('Invalid graph arguments');
      expect(errors).not.toHaveBeenCalled();
    }
  });

  it('help short circuits even mutation-like arguments and never reads sources', async () => {
    expect(await cmdGraph(['destroy', '--help'])).toBe(0);
    expect(output.mock.calls[0]![0]).toContain('usage: phm graph status');
    expect(native.config).not.toHaveBeenCalled();
  });

  it('reports missing sources without creating them or claiming healthy emptiness', async () => {
    const graph = await readRegistryGraph({ fleet: join(root, 'absent'), seats: join(root, 'absent-seats') });
    expect(graph).toMatchObject({ complete: false, sources: { fleet: 'missing', seats: 'missing' }, nodes: [], edges: [] });
    expect(graph.issues).toEqual([{ source: 'fleet', code: 'missing' }, { source: 'seats', code: 'missing' }]);
    expect(readdirSync(root).sort()).toEqual(['fleet.json', 'seats.json']);
  });

  it('withholds invalid JSON and returns exit 1 with sanitized diagnostics', async () => {
    writeFileSync(fleetPath, '{ "private": "DO_NOT_ECHO_THIS"');
    expect(await cmdGraph(['status', '--fleet', fleetPath, '--seats', seatsPath, '--json'])).toBe(1);
    const text = String(output.mock.calls[0]![0]);
    expect(text).not.toContain('DO_NOT_ECHO_THIS');
    expect(text).not.toContain(root);
    expect(JSON.parse(text)).toMatchObject({ complete: false, sources: { fleet: 'invalid', seats: 'loaded' } });
  });

  it('refuses oversized files before parsing', async () => {
    writeFileSync(seatsPath, ' '.repeat(GRAPH_SOURCE_MAX_BYTES + 1));
    expect(await readRegistryGraph({ fleet: fleetPath, seats: seatsPath }))
      .toMatchObject({ complete: false, sources: { seats: 'unavailable' } });
  });

  it('refuses directories as input', async () => {
    expect(await readRegistryGraph({ fleet: root, seats: seatsPath }))
      .toMatchObject({ complete: false, sources: { fleet: 'unavailable' } });
  });

  it.runIf(process.platform !== 'win32')('refuses symlinks as input', async () => {
    const link = join(root, 'link.json');
    symlinkSync(seatsPath, link);
    expect(await readRegistryGraph({ fleet: fleetPath, seats: link }))
      .toMatchObject({ complete: false, sources: { seats: 'unavailable' } });
  });

  it('uses native metadata only and projects catalog declarations, never health or launcher data', async () => {
    writeFileSync(fleetPath, JSON.stringify({ schema: 'fleet.v1', agents: [], mcp: [], edges: [] }));
    writeFileSync(join(root, 'connections.json'), JSON.stringify({ schemaVersion: 1, intervalMs: 30_000,
      accounts: [{ id: 'codex-work', label: 'Work', provider: 'codex', command: ['/private/launcher.mjs'] }] }));
    const graph = await readRegistryGraph({ fleet: fleetPath });
    expect(graph.complete).toBe(true);
    expect(graph.nodes).toContainEqual({ id: 'model:codex/catalog-model', kind: 'model', engine: 'codex', modelId: 'catalog-model' });
    expect(native.profile).toHaveBeenCalledWith(['/private/launcher.mjs'], 'codex');
    expect(native.models).toHaveBeenCalledWith('codex', null);
    expect(native.discover).not.toHaveBeenCalled();
    expect(JSON.stringify(graph)).not.toMatch(/private|launcher|old CLI|fallback/);
  });

  it('does not collapse malformed native roster or configuration failures into a loaded empty source', async () => {
    writeFileSync(join(root, 'connections.json'), JSON.stringify({ accounts: 'bad' }));
    expect((await readRegistryGraph({ fleet: fleetPath })).sources.seats).toBe('invalid');
    native.config.mockImplementationOnce(() => { throw new Error('PRIVATE_CONFIG'); });
    const graph = await readRegistryGraph({ fleet: fleetPath });
    expect(graph.sources.seats).toBe('unavailable');
    expect(JSON.stringify(graph)).not.toContain('PRIVATE_CONFIG');
  });
});
