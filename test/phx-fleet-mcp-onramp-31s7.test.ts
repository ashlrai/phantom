import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../src/mcp/fleet-server.js';

const guide = readFileSync(new URL('../docs/FLEET-MCP-ONRAMP.md', import.meta.url), 'utf8');
const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!) as unknown);
const config = blocks[0] as { mcpServers: Record<string, { command: string; args: string[] }> };
const sequence = blocks[1] as Array<{ name: string; arguments: Record<string, unknown> }>;

async function withClient(readers: FleetReaders, run: (client: Client) => Promise<void>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'onramp-fixture', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return content[0]!.text;
}

describe('standalone fleet MCP onramp', () => {
  it('uses the documented config and executes its listed sequence with JSON observations', async () => {
    expect(config.mcpServers['phantom-fleet']).toEqual({ command: 'phm', args: ['mcp', 'fleet'] });
    expect(sequence.map(call => call.name)).toEqual(['fleet_status', 'fleet_loop', 'fleet_bus_hops']);
    const status = { snapshotKind: 'local-persisted', authority: 'none', queue: { backlogItems: 2 } };
    const loop = { snapshotKind: 'local-persisted', historyLimit: 5, recentTicks: [{ ts: '2026-01-01T00:00:00Z' }] };
    const bus = { snapshotKind: 'local-persisted', sourceState: 'ok', limit: 5, hops: [{ id: 'fake-hop-1', from: 'agent-a', to: 'agent-b', inputTokens: null, outputTokens: 3 }] };
    const readers = { status: vi.fn(async () => status), loop: vi.fn(async () => loop), bus: vi.fn(async () => bus) };
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      await withClient(readers, async client => {
        const listed = await client.listTools();
        expect(listed.tools.map(tool => tool.name)).toEqual(sequence.map(call => call.name));
        for (const [index, call] of sequence.entries()) {
          const result = await client.callTool(call);
          expect(result.isError).not.toBe(true);
          expect(JSON.parse(textContent(result))).toEqual([status, loop, bus][index]);
        }
      });
      expect(readers.status).toHaveBeenCalledWith();
      expect(readers.loop).toHaveBeenCalledWith(5);
      expect(readers.bus).toHaveBeenCalledWith(5);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('returns a sanitized source error and remains usable', async () => {
    const readers: FleetReaders = {
      status: async () => { throw new Error('fake-private-source-detail'); },
      loop: async limit => ({ historyLimit: limit }),
      bus: async () => ({ sourceState: 'missing', hops: null }),
    };
    await withClient(readers, async client => {
      const result = await client.callTool(sequence[0]!);
      expect(result.isError).toBe(true);
      expect(textContent(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
      expect(JSON.stringify(result)).not.toContain('fake-private-source-detail');
      expect(JSON.parse(textContent(await client.callTool(sequence[1]!)))).toEqual({ historyLimit: 5 });
    });
  });

  it('returns a tool error instead of partial JSON above the UTF-8 output cap', async () => {
    await withClient({
      status: async () => ({ text: '界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2) }),
      loop: async () => ({}), bus: async () => ({}),
    }, async client => {
      const result = await client.callTool(sequence[0]!);
      expect(result.isError).toBe(true);
      expect(textContent(result)).toBe('Fleet observation exceeds the output limit; request a smaller limit.');
    });
  });
});
