import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import { fleetEmpties } from '../../src/core/fleet/empties.js';

it('exposes the same empty report, validates hours and refuses caller paths before reading', async () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const report = await fleetEmpties(async () => JSON.stringify({ event: 'finish', job: 'RQ-EMPTY1', ts: new Date(now).toISOString(), empty: true, reason: 'scope-unclear' }), 24, now);
  const empties = vi.fn(async () => report);
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), empties });
  const client = new Client({ name: 'empty-report-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_empties');
    expect(tool).toMatchObject({ annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { additionalProperties: false, properties: { hours: { default: 24, maximum: 2160, exclusiveMinimum: 0 } } } });
    for (const hours of [undefined, 0.5, 2160]) {
      const result = await client.callTool({ name: 'fleet_empties', arguments: hours === undefined ? {} : { hours } });
      expect(result).toMatchObject({ content: [{ type: 'text', text: JSON.stringify(report) }] });
      expect(empties).toHaveBeenLastCalledWith(hours ?? 24);
    }
    for (const args of [{ hours: 0 }, { hours: -1 }, { hours: 2161 }, { hours: '24' }, { hours: null },
      { root: '/tmp' }, { path: '/tmp/jobs' }, { cwd: '/tmp' }, { hours: 24, jobs: '/tmp/jobs' }]) {
      await expect(client.callTool({ name: 'fleet_empties', arguments: args })).rejects.toMatchObject({ code: -32602 });
    }
    expect(empties).toHaveBeenCalledTimes(3);
  } finally { await client.close(); await server.close(); }
});
