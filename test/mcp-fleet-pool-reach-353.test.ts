/**
 * RQ-PHX-POOLREACHMCP353 — fleet_pool_reach: read-only, argument-free MCP
 * evidence of whether the node pool's primary and backup SSH aliases match
 * online tailnet peers. Hermetic: in-memory transports, injected reader;
 * never runs real tailscale or reads ~/.ashlr.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'pool-reach-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const NAME = 'fleet_pool_reach';
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

describe('fleet_pool_reach MCP tool', () => {
  it('is listed with an empty closed schema and read-only annotations', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === NAME);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('returns the reader pool-reach report unchanged', async () => {
    const report = {
      asOf: '2026-01-01T00:00:00.000Z',
      self: 'fake-self',
      role: 'primary',
      hosts: [
        { slot: 'primary', alias: 'mac-primary', matched: 'mac-primary', online: true, lastSeen: '2026-01-01T00:00:00.000Z', ageSeconds: 0, isSelf: true },
        { slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false, lastSeen: '2025-12-31T00:00:00.000Z', ageSeconds: 86400, isSelf: false },
      ],
      reasons: [],
    };
    const result = await (await connect({ poolReach: async () => report })).callTool({ name: NAME });
    expect(JSON.parse(text(result))).toEqual(report);
    expect(text(result)).not.toMatch(IPV4);
    expect(text(result)).not.toContain('/Users/');
  });

  it('a throwing reader reports unknown without the thrown text', async () => {
    const result = await (await connect({
      poolReach: async () => { throw new Error('boom 100.64.0.1 sk-secret /Users/someone'); },
    })).callTool({ name: NAME });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'pool-reach-unavailable' });
    expect(text(result)).not.toMatch(/boom|sk-|100\.64|\/Users\//);
  });

  it('refuses any argument', async () => {
    const client = await connect({ poolReach: async () => ({ hosts: [] }) });
    for (const args of [{ root: '/tmp' }, { cwd: '.' }, { limit: 1 }]) {
      await expect(client.callTool({ name: NAME, arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });

  it('a reader that never resolves yields a bounded unknown result', async () => {
    const client = await connect({ poolReach: () => new Promise(() => {}) });
    vi.useFakeTimers();
    const pending = client.callTool({ name: NAME });
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'pool-reach-timeout' });
    expect(text(result)).not.toMatch(IPV4);
    expect(text(result)).not.toContain('/Users/');
  });
});
