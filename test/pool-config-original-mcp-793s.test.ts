import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';

const fake = vi.hoisted(() => ({ readConfig: vi.fn() }));
vi.mock('../src/core/drive/nodes/pool-host.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/drive/nodes/pool-host.js')>(),
  readPoolConfig: fake.readConfig,
}));
vi.mock('../src/core/fleet/tailnet-peers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/tailnet-peers.js')>(),
  defaultTailnetPeersDeps: () => peers,
}));

import { readPoolReach } from '../src/core/fleet/pool-reach.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const config: PoolConfig = { role: 'worker', primary: 'primary', backup: 'backup', owner: 'owner', node: 'node' };
const initialTime = '2026-11-14T12:00:00.000Z';
const recoveredTime = '2026-11-14T12:01:00.000Z';
let observedTime = initialTime;
const exec = vi.fn(() => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'self' }, Peer: {
  a: { HostName: 'primary', Online: true }, b: { HostName: 'backup', Online: true },
} }));
const peers: TailnetPeersDeps = {
  now: () => new Date(observedTime),
  homeDir: () => '/home/fake-private-home',
  exec,
};
const diagnostic = 'FAKE_PRIVATE_DIAGNOSTIC /home/fake-private-home/config';

function assertRefusal(value: unknown) {
  expect(value).toMatchObject({ role: 'unknown', hosts: [], reasons: ['pool config: pool config unreadable'] });
  expect(JSON.stringify(value)).not.toContain('FAKE_PRIVATE_DIAGNOSTIC');
  expect(JSON.stringify(value)).not.toContain('/home/fake-private-home');
}

describe('original pool config refusal through MCP', () => {
  it.each([new Error(diagnostic), diagnostic])('refuses diagnostic %# and recovers fresh host evidence', async failure => {
    fake.readConfig.mockReset().mockReturnValue(config);
    exec.mockClear();
    observedTime = initialTime;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer();
    const client = new Client({ name: 'test', version: '1' });
    await server.connect(st);
    await client.connect(ct);
    try {
      const before = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
      expect(JSON.parse((before.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
        asOf: initialTime, role: 'worker', reasons: [], hosts: [
          { alias: 'primary', online: true }, { alias: 'backup', online: true },
        ],
      });
      fake.readConfig.mockImplementation(() => { throw failure; });
      const refusal = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
      expect(refusal.isError).toBeFalsy();
      expect(JSON.stringify(refusal)).not.toContain('FAKE_PRIVATE_DIAGNOSTIC');
      expect(JSON.stringify(refusal)).not.toContain('/home/fake-private-home');
      assertRefusal(JSON.parse((refusal.content as Array<{ text: string }>)[0]!.text));
      assertRefusal(readPoolReach({ readConfig: fake.readConfig, peers }));

      observedTime = recoveredTime;
      fake.readConfig.mockReturnValue({ ...config, primary: 'recovered-primary', backup: 'recovered-backup' });
      exec.mockReturnValueOnce(JSON.stringify({ BackendState: 'Running', Self: { HostName: 'self' }, Peer: {
        a: { HostName: 'recovered-primary', Online: true }, b: { HostName: 'recovered-backup', Online: false },
      } }));
      const response = await client.callTool({ name: 'fleet_pool_reach', arguments: {} });
      expect(response.isError).toBeFalsy();
      const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      expect(result).toMatchObject({ asOf: recoveredTime, role: 'worker', reasons: [], hosts: [
        { alias: 'recovered-primary', matched: 'recovered-primary', online: true },
        { alias: 'recovered-backup', matched: 'recovered-backup', online: false },
      ] });
      expect(fake.readConfig).toHaveBeenCalledTimes(4);
      expect(exec.mock.calls).toEqual(Array.from({ length: 4 }, () => ['tailscale', ['status', '--json']]));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
