import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

afterEach(() => vi.restoreAllMocks());

it('uses each MCP observation clock for a non-reaping board read', async () => {
  const reader = vi.spyOn(coordination, 'readFleetBoard').mockReturnValue({
    schema: 'fleet.coordination.v1', state: 'known', claims: [], proposals: [],
    messages: [], expiredClaims: 0,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer();
  const client = new Client({ name: 'recut-mcp-c551', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const name of ['fleet_coordination_claims', 'fleet_coordination_returns']) {
      reader.mockClear();
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).not.toBe(true);
      const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(value.state).toBe('known');
      expect(Number.isFinite(Date.parse(value.asOf))).toBe(true);
      expect(reader).toHaveBeenCalledExactlyOnceWith({ now: Date.parse(value.asOf), reap: false });
    }
  } finally {
    await client.close();
    await server.close();
  }
});
