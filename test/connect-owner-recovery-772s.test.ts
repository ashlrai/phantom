import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetConnect } from '../src/cli/fleet-connect.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { buildConnectList, formatConnectList, type ConnectReaders } from '../src/core/fleet/connect-list.js';
import type { InstalledPanel } from '../src/core/fleet/installed-panels.js';

const mutations = vi.hoisted(() => ({ toggle: vi.fn(() => { throw new Error('mutation forbidden'); }) }));
vi.mock('../src/core/verse/connector-manager.js', () => ({
  listConnectors: async () => ({ revision: 'a'.repeat(40), connectors: [{ name: 'fixture-gateway', enabled: true }] }),
  setConnectorEnabled: mutations.toggle,
}));
const now = () => new Date('2026-11-22T00:00:00.000Z');
const panel = (schema: InstalledPanel['schema']): InstalledPanel => ({ schema, observedAt: '', sources: [], items: [] });
const fixtures = (): ConnectReaders => ({
  channels: async () => ({ overview: { schema: 'phantom.channels.v1', version: 1, at: '', counts: { connected: 0, 'not-set-up': 1, failing: 0, unknown: 0 }, channels: [
    { channel: 'email', label: 'Email', state: 'not-set-up', reason: null, lastInboundAt: null, lastOutboundAt: null, messages24h: 0, verifiedSenders: 0, address: null, next: 'Configure email' },
  ] }, needSignIn: ['email'] }),
  gateway: async () => ({ revision: 'a'.repeat(40), connectors: [{ name: 'gateway', enabled: true }, { name: 'disabled', enabled: false }] }),
  profile: async () => [{ id: 'mail', availability: 'available', lanes: ['z', 'a'], needsCredential: true }, { id: 'missing', availability: 'unavailable', lanes: [], needsCredential: false }],
  plugins: () => ({ ...panel('fleet.plugins-panel.v1'), items: [{ name: 'plugin', source: 'Phantom', enabled: 'unknown', lastUsed: 'unknown', agents: 'Owner' }] }),
  skills: () => panel('fleet.skills-panel.v1'), tools: async () => null,
  registry: async () => [{ id: 'tool', status: 'active', lanes: [] }, { id: 'revoked', status: 'revoked', lanes: [] }],
});
afterEach(() => vi.restoreAllMocks());
describe('shared connection owner recovery', () => {
  it('preserves the schema, mixed states, unknown evidence and deterministic ordering', async () => {
    const readers = fixtures();
    const list = await buildConnectList({ readers, now });
    expect(list).toMatchObject({ schema: 'phantom.connect.v1', version: 1, unread: ['tool'], counts: { on: 2, off: 3, broken: 1, unknown: 2 } });
    expect(list.rows.map(r => r.name)).toEqual(['Email', 'missing', 'mail', 'disabled', 'gateway', 'plugin', 'revoked', 'tool']);
    expect(list.rows.find(r => r.name === 'mail')).toMatchObject({ state: 'unknown', needsSignIn: true, lastUsed: 'unknown', users: ['a', 'z'] });
    expect(list.rows[0]).toMatchObject({ lastUsed: null, needsSignIn: true });
    const gateway = readers.gateway;
    readers.gateway = async () => { const v = await gateway(); return { ...v, connectors: v.connectors.reverse() }; };
    expect(await buildConnectList({ readers, now })).toEqual(list);
  });
  it('keeps successful sources when one fails and never prints the source error', async () => {
    const readers = fixtures(); readers.gateway = async () => { throw new Error('private failure detail'); };
    const list = await buildConnectList({ readers, kind: 'connector', now });
    expect(list.unread).toEqual(['connector']);
    expect(list.rows.map(r => r.name)).toEqual(['missing', 'mail']);
    expect(formatConnectList(list)).toContain('some could not be read: unknown');
    expect(JSON.stringify(list)).not.toContain('private failure detail');
  });
  it('sanitizes every source-controlled display field and bounds rows', async () => {
    const readers = fixtures(); const dirty = '\x1b[31mBAD\n\u202e api_key=fixture-sensitive-value';
    readers.plugins = () => ({ ...panel('fleet.plugins-panel.v1'), sources: [{ source: dirty, state: 'unknown', count: 300 }], items: Array.from({ length: 300 }, (_, i) => ({ name: `${i} ${dirty}` + 'x'.repeat(300), source: dirty, agents: dirty, enabled: false, lastUsed: dirty })) });
    readers.gateway = async () => ({ revision: dirty, connectors: [{ name: dirty, enabled: false }] });
    const list = await buildConnectList({ readers, now });
    const output = JSON.stringify(list) + formatConnectList(list);
    for (const value of ['fixture-sensitive-value', '\x1b', '\u202e']) expect(output).not.toContain(value);
    expect(list.unread).toEqual(['plugin', 'tool']);
    expect(list.rows.filter(r => r.kind === 'plugin')).toHaveLength(256);
    for (const row of list.rows) { expect(row.name.length).toBeLessThanOrEqual(160); expect(row.source.length).toBeLessThanOrEqual(240); }
    expect(list.rows.find(r => r.kind === 'plugin')?.lastUsed).toBe('unknown');
    expect(list.rows.find(r => r.source === 'Gateway')?.toggle).toBeNull();
  });
  it('loads the convention export and prints both CLI formats without mutations', async () => {
    const resolved = resolveFleetSubcommand('connect')!;
    expect(resolved.module).toBe('./fleet-connect.js');
    const module = await import('../src/cli/fleet-connect.js');
    expect(module[resolved.exportName]).toBe(cmdFleetConnect);
    const readers = fixtures();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetConnect(['list', '--json', '--kind', 'skill'], readers)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ kind: 'skill', rows: [], unread: [] });
    expect(await cmdFleetConnect(['list'], readers)).toBe(0);
    expect(String(log.mock.calls[1]![0])).toContain('needs sign-in');
    // Exercise the actual default gateway adapter with its write export trapped.
    const list = await buildConnectList({ kind: 'connector', readers: { profile: readers.profile }, now });
    expect(list.rows.find(row => row.source === 'Gateway')?.name).toBe('fixture-gateway');
    expect(mutations.toggle).not.toHaveBeenCalled();
  });
  it('rejects invalid kinds and write verbs before invoking any reader', async () => {
    const read = vi.fn(() => { throw new Error('must not read'); });
    const readers = Object.fromEntries(Object.keys(fixtures()).map(k => [k, read])) as unknown as ConnectReaders;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['list', '--kind', 'invalid'], ['enable'], ['list', '--apply']]) expect(await cmdFleetConnect(args, readers)).toBe(2);
    await expect(buildConnectList({ kind: 'invalid' as never, readers })).rejects.toThrow('Invalid connection kind');
    expect(read).not.toHaveBeenCalled();
  });
});
