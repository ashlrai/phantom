import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdInventory, INVENTORY_USAGE } from '../src/cli/inventory.js';
import { buildInventory, type Inventory } from '../src/core/fleet/inventory.js';
import { buildToolParity } from '../src/core/fleet/tool-parity.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const inventory = buildInventory({
  now: NOW, channels: null, plugins: null, skills: null, roster: ['claude', 'zai'],
  connectors: [{ id: 'tracker', kind: 'cli', description: 'Ticket lookup', lanes: ['claude'], credentials: 1, availability: 'unavailable' }],
  tools: buildToolParity({ lanes: ['claude', 'zai'], sources: [{ name: 'lane-tools.json', lanes: { claude: { capabilities: { browser: true } }, zai: { capabilities: { browser: false } } } }] }),
  registry: [],
});
const read = async (): Promise<Inventory> => inventory;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  return { out, err };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('phm inventory', () => {
  it('--json prints phantom.inventory.v1 with the documented shape', async () => {
    const io = capture();
    expect(await cmdInventory(['--json'], { read })).toBe(0);
    const json = JSON.parse(io.out.join('\n')) as Inventory;
    expect(Object.keys(json)).toEqual(['schema', 'version', 'at', 'kind', 'counts', 'kinds', 'items', 'parity']);
    expect(json).toMatchObject({ schema: 'phantom.inventory.v1', version: 1, at: NOW.toISOString(), kind: null });
    expect(Object.keys(json.counts)).toEqual(['ready', 'needs setup', 'off', 'error', 'unknown']);
    expect(json.kinds.map(k => k.kind)).toEqual(['channel', 'connector', 'plugin', 'skill', 'tool']);
    for (const item of json.items) expect(Object.keys(item)).toEqual(['kind', 'id', 'name', 'state', 'detail', 'lastChecked', 'usedByLanes', 'next']);
    expect(json.items.find(i => i.id === 'connector:tracker')).toEqual({
      kind: 'connector', id: 'connector:tracker', name: 'tracker', state: 'needs setup',
      detail: 'CLI. Ticket lookup. Its program is not on PATH. Lists 1 credential name; whether each is set is not checked here.',
      lastChecked: NOW.toISOString(), usedByLanes: ['claude'],
      next: { text: 'Install its program so it is on PATH, then check it again.', command: 'phm connectors show tracker' },
    });
    expect(Object.keys(json.parity)).toEqual(['compared', 'widestGap', 'lanes']);
    expect(json.parity.lanes).toEqual([
      { lane: 'claude', has: ['connector:tracker', 'tool:browser'], lacks: [], unknown: 6, gap: 0 },
      { lane: 'zai', has: [], lacks: ['connector:tracker', 'tool:browser'], unknown: 6, gap: 2 },
    ]);
    expect(json.parity.widestGap).toBe(2);
  });

  it('--kind narrows to one kind, singular or plural', async () => {
    for (const word of ['connector', 'connectors']) {
      const io = capture();
      expect(await cmdInventory(['--kind', word, '--json'], { read })).toBe(0);
      const json = JSON.parse(io.out.join('\n')) as Inventory;
      expect(json.kind).toBe('connector');
      expect(json.items.map(i => i.kind)).toEqual(['connector']);
      expect(json.kinds.map(k => k.kind)).toEqual(['connector']);
      expect(json.counts).toEqual({ ready: 0, 'needs setup': 1, off: 0, error: 0, unknown: 0 });
      vi.restoreAllMocks();
    }
  });

  it('prints plain text by default', async () => {
    const io = capture();
    expect(await cmdInventory([], { read })).toBe(0);
    const text = io.out.join('\n');
    expect(text).toContain('Connectors (1): 0 ready, 1 needs setup, 0 off, 0 error, 0 unknown');
    expect(text).toContain('Tool gap between lanes: 2.');
  });

  it('exits 2 on bad usage without reading anything, and 0 for --help', async () => {
    const never = vi.fn(read);
    let io = capture();
    expect(await cmdInventory(['--kind', 'secrets'], { read: never })).toBe(2);
    expect(io.err.join('\n')).toBe('Unknown kind "secrets". Use one of: channel, connector, plugin, skill, tool.');
    vi.restoreAllMocks();
    io = capture();
    expect(await cmdInventory(['--kind', 'nope', '--json'], { read: never })).toBe(2);
    expect(JSON.parse(io.err.join('\n'))).toEqual({ error: 'Unknown kind "nope". Use one of: channel, connector, plugin, skill, tool.' });
    for (const bad of [['--kind'], ['--bogus'], ['extra'], ['--kind', 'tool', '--kind', 'skill']]) expect(await cmdInventory(bad, { read: never })).toBe(2);
    vi.restoreAllMocks();
    io = capture();
    expect(await cmdInventory(['--help'], { read: never })).toBe(0);
    expect(io.out.join('\n')).toBe(INVENTORY_USAGE);
    expect(never).not.toHaveBeenCalled();
  });
});
