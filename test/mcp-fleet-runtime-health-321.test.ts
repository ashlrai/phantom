/**
 * RQ-PHX-MCPRUNTIMEHEALTH321 — fleet_runtime_identity and fleet_channel_health:
 * read-only, argument-free MCP evidence of who is running and whether the
 * Slack/iMessage channels are up. Hermetic: in-memory transports, injected readers.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'runtime-health-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args?: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text };
}

const TOOLS = ['fleet_runtime_identity', 'fleet_channel_health'];

describe('fleet runtime identity and channel health MCP tools', () => {
  it('lists both tools with closed, argument-free schemas', async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of TOOLS) {
      const tool = tools.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    }
  });

  it('fleet_runtime_identity returns the identity shape with no secrets', async () => {
    const { result, text } = await call(await connect(), 'fleet_runtime_identity');
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['host', 'asOf', 'installedVersion', 'fleetState']) expect(parsed).toHaveProperty(key);
    for (const needle of ['sk-', 'xox', 'ghp_']) expect(text).not.toContain(needle);
  });

  it.each(TOOLS)('%s refuses any argument', async (name) => {
    const client = await connect({ channelHealth: async () => ({ schemaVersion: 1, channels: [] }) });
    for (const args of [{ root: '/tmp' }, { cwd: '.' }, { limit: 1 }]) {
      await expect(call(client, name, args)).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });

  it('fleet_channel_health returns the reader report as is', async () => {
    const report = { schemaVersion: 1, asOf: '2026-01-01T00:00:00.000Z', channels: [] };
    const { text } = await call(await connect({ channelHealth: async () => report }), 'fleet_channel_health');
    expect(JSON.parse(text)).toEqual(report);
  });

  it('a throwing channel-health reader reports unknown, never ok', async () => {
    const { result, text } = await call(await connect({
      channelHealth: async () => { throw new Error('boom /Users/someone sk-secret'); },
    }), 'fleet_channel_health');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toEqual({ status: 'unknown', reason: 'channel-health-unavailable' });
    expect(text).not.toMatch(/boom|sk-|Users/);
  });

  it('documents both tools in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    for (const name of TOOLS) expect(md).toMatch(new RegExp(`^\\| phantom-fleet \\| \`${name}\` \\|`, 'm'));
  });
});
