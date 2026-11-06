import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { parseFleetWasteRiskArgs, readFleetWasteRiskTool } from '../../src/mcp/fleet-waste-risk.js';
import type { WasteRiskInput } from '../../src/core/resources/waste-risk.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(wasteRisk?: FleetReaders['wasteRisk']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'waste-risk-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), wasteRisk }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const highLane: WasteRiskInput = {
  lane: 'claude', used: 40, limit: 100,
  window_start: '2026-10-30T00:00:00.000Z', reset_at: '2026-11-04T14:00:00.000Z',
  now: '2026-11-04T12:00:00.000Z', burn_per_hour: 0, running: 1,
  per_job_cost: null, ceiling: 4, held: false,
};
const lowLane: WasteRiskInput = {
  ...highLane, lane: 'codex', used: 95, reset_at: '2026-11-04T22:00:00.000Z',
};

describe('fleet_waste_risk over MCP', () => {
  it('is advertised observation-only with an empty strict schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_waste_risk');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('returns the injected reader JSON through the protocol', async () => {
    const payload = {
      schema: 'fleet.waste-risk.mcp.v1', generatedAt: '2026-11-04T12:00:00.000Z', available: true, high: 1,
      lanes: [{ lane: 'claude', waste_risk: 'high', projected_unused_at_reset: 60 }],
    };
    const client = await connect(async () => payload);
    const out = parse(await client.callTool({ name: 'fleet_waste_risk', arguments: {} }));
    expect(out).toEqual(payload);
  });

  it('projects inputs, sorts high waste first and counts high lanes', async () => {
    const out = await readFleetWasteRiskTool({ read: async () => [lowLane, highLane], now: () => NOW });
    expect(out).toMatchObject({ schema: 'fleet.waste-risk.mcp.v1', generatedAt: '2026-11-04T12:00:00.000Z', high: 1, available: true });
    expect(out.lanes).toHaveLength(2);
    expect(out.lanes[0]).toMatchObject({ lane: 'claude', waste_risk: 'high', projected_unused_at_reset: 60, hours_to_reset: 2 });
    expect(out.lanes[1]).toMatchObject({ lane: 'codex', waste_risk: 'low' });
  });

  it.each([{ x: 1 }, { path: '/tmp/x' }, { runsDir: '/tmp/x' }, { limit: 1 }, { lane: 'claude' }])(
    'rejects arguments before any read: %j', async args => {
      const reader = vi.fn(async () => ({}));
      const client = await connect(reader);
      await expect(client.callTool({ name: 'fleet_waste_risk', arguments: args })).rejects.toMatchObject({ code: -32602 });
      expect(reader).not.toHaveBeenCalled();
    });

  it('parseFleetWasteRiskArgs accepts only the empty object', () => {
    expect(parseFleetWasteRiskArgs({})).toEqual({});
    for (const args of [{ x: 1 }, { limit: 1 }, { runsDir: '/tmp/x' }]) {
      expect(parseFleetWasteRiskArgs(args)).toBeNull();
    }
  });

  it('reports a throwing read as unavailable with empty lanes and no error detail', async () => {
    const out = await readFleetWasteRiskTool({ read: async () => { throw new Error('private-source-value /Users/me/token'); }, now: () => NOW });
    expect(out).toEqual({ schema: 'fleet.waste-risk.mcp.v1', generatedAt: '2026-11-04T12:00:00.000Z', lanes: [], high: 0, available: false });
    expect(JSON.stringify(out)).not.toMatch(/private-source-value|\/Users/);
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect(async () => { throw new Error('private-source-value /Users/me/token'); });
    const result = await client.callTool({ name: 'fleet_waste_risk' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-source-value|\/Users/);
  });
});
