import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdDesktop } from '../src/cli/desktop.js';
import * as status from '../src/core/desktop/native-update-status.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let home: string;
let file: string;
const native = { schema: 'desktop.native-update-status.v1', phase: 'waiting-for-idle',
  reason: 'stop-required', version: '3.30.76', enabled: true };
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'native-update-status-')));
  const dir = join(home, '.ashlr/updates');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  file = join(dir, 'native-status.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

it('reports absent, stale, and unsafe observations without inferring a native reason', () => {
  expect(status.readNativeUpdateStatus(home)).toMatchObject({ phase: null, reason: 'native-status-unavailable' });
  writeFileSync(file, JSON.stringify(native), { mode: 0o600 });
  const old = new Date(Date.now() - 21 * 60_000);
  utimesSync(file, old, old);
  expect(status.readNativeUpdateStatus(home)).toMatchObject({ phase: null, reason: 'native-status-stale' });
  writeFileSync(file, JSON.stringify({ ...native, reason: 'fabricated-reason' }));
  expect(status.readNativeUpdateStatus(home)).toMatchObject({ phase: null, reason: 'native-status-invalid' });
  rmSync(file);
  const alternate = join(home, 'alternate');
  writeFileSync(alternate, JSON.stringify(native), { mode: 0o600 });
  symlinkSync(alternate, file);
  expect(status.readNativeUpdateStatus(home)).toMatchObject({ phase: null, reason: 'native-status-invalid' });
});

it('offers the same native phase, fixed reason and remedy in CLI and MCP', async () => {
  writeFileSync(file, JSON.stringify({ ...native, unexpected: '/not-for-agents' }), { mode: 0o600 });
  const observed = status.readNativeUpdateStatus(home);
  expect(observed).toMatchObject({ source: 'last-native-observation', phase: 'waiting-for-idle',
    reason: 'stop-required', version: '3.30.76', remedy: expect.stringContaining('phm authority stop') });
  expect(JSON.stringify(observed)).not.toContain('/not-for-agents');
  vi.spyOn(status, 'readNativeUpdateStatus').mockReturnValue(observed);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdDesktop(['update', 'status', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(observed);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
  const client = new Client({ name: 'desktop-update-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'fleet_desktop_update_status' });
    const content = result.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(observed);
    await expect(client.callTool({ name: 'fleet_desktop_update_status', arguments: { root: home } })).rejects.toThrow('Invalid desktop update status arguments.');
  } finally { await client.close(); }
});
