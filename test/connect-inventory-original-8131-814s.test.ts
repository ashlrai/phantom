import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetConnect } from '../src/cli/fleet-connect.js';
import { buildConnectList, type ConnectReaders } from '../src/core/fleet/connect-list.js';
import type { InstalledPanel } from '../src/core/fleet/installed-panels.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';

const panel = (schema: InstalledPanel['schema']): InstalledPanel => ({ schema, observedAt: '2026-01-01T00:00:00Z', sources: [], items: [] });
const readers = (): ConnectReaders => ({
  channels: async () => ({ overview: { schema: 'fleet.channels-overview.v1', version: 1, at: '', counts: { connected: 0, 'not-set-up': 0, failing: 0, unknown: 0 }, channels: [] }, needSignIn: [] }),
  gateway: async () => ({ revision: 'rev', connectors: [{ name: 'gateway', enabled: true }] }),
  profile: async () => [{ id: 'mail', availability: 'available', lanes: ['fake-lane'], needsCredential: true }],
  plugins: () => panel('fleet.plugins-panel.v1'), skills: () => panel('fleet.skills-panel.v1'),
  tools: async () => null, registry: async () => [{ id: 'tool', status: 'active', lanes: [] }],
});
afterEach(() => vi.restoreAllMocks());
describe('connection inventory recovery', () => {
  it('registers the recovered verb and keeps all convention loaders in sync', async () => {
    expect(generateFleetRegistry(['--check'])).toBe(0);
    expect((await FLEET_SUBCOMMAND_LOADERS['connect']!())['cmdFleetConnect']).toBe(cmdFleetConnect);
  });
  it('preserves measured rows, unknown evidence and source attribution', async () => {
    const list = await buildConnectList({ readers: readers(), now: () => new Date('2026-01-01T00:00:00Z') });
    expect(list).toMatchObject({ schema: 'phantom.connect.v1', unread: ['tool'], counts: { on: 2, off: 0, broken: 0, unknown: 1 } });
    expect(list.rows.find(r => r.name === 'mail')).toMatchObject({ source: 'Connector profile', state: 'unknown', lastUsed: 'unknown', needsSignIn: true });
    expect(list.rows.find(r => r.name === 'gateway')).toMatchObject({ source: 'Gateway', state: 'on' });
  });
  it('keeps other sources when one throws and filters kinds', async () => {
    const r = readers(); r.gateway = async () => { throw new Error('unread'); };
    const list = await buildConnectList({ readers: r, kind: 'connector' });
    expect(list.unread).toEqual(['connector']); expect(list.rows.map(row => row.name)).toEqual(['mail']);
  });
  it('handles JSON, empty results, kind selection and bad arguments at the command boundary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetConnect(['list', '--json', '--kind', 'skill'], readers())).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ kind: 'skill', rows: [], unread: [] });
    expect(await cmdFleetConnect(['list', '--kind', 'bad'], readers())).toBe(2);
    expect(await cmdFleetConnect(['list', '--unexpected'], readers())).toBe(2);
  });
});
