import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { cmdMcp } from '../../src/cli/mcp.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
async function connect(readers: FleetReaders = { status: async () => ({ pending: 2 }), loop: async limit => ({ limit }) }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'fleet-test-model', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet MCP protocol', () => {
  it('negotiates a tools-only server and advertises exactly two read-only tools', async () => {
    const client = await connect();
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(client.getServerVersion()?.name).toBe('phantom-fleet');
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['fleet_status', 'fleet_loop']);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('round trips status and loop calls with omitted/default and explicit limits', async () => {
    const client = await connect();
    expect(await client.callTool({ name: 'fleet_status' })).toMatchObject({ content: [{ type: 'text', text: '{"pending":2}' }] });
    expect(await client.callTool({ name: 'fleet_loop' })).toMatchObject({ content: [{ text: '{"limit":20}' }] });
    expect(await client.callTool({ name: 'fleet_loop', arguments: { limit: 50 } })).toMatchObject({ content: [{ text: '{"limit":50}' }] });
  });

  it.each([
    ['fleet_pause', {}], ['ashlr_fleet_status', {}], ['fleet_status', { limit: 1 }],
    ['fleet_loop', { limit: 0 }], ['fleet_loop', { limit: 51 }], ['fleet_loop', { limit: 1.5 }],
    ['fleet_loop', { limit: '2' }], ['fleet_loop', { limit: null }], ['fleet_loop', { command: 'start' }],
    ['fleet_status', { path: '/private' }],
  ])('rejects invalid tool/arguments before invoking readers: %s %j', async (name, args) => {
    const status = vi.fn(), loop = vi.fn();
    const client = await connect({ status, loop });
    await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(status).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
  });

  it('scrubs persisted secret-shaped prose and home paths before returning JSON', async () => {
    const fakeSecret = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const client = await connect({ status: async () => ({ reason: `token=${fakeSecret}`, path: `${process.env.HOME}/repo` }), loop: async () => ({}) });
    const result = await client.callTool({ name: 'fleet_status' });
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
    expect(JSON.stringify(result)).not.toContain(process.env.HOME);
    expect(JSON.stringify(result)).toContain('REDACTED');
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(() => JSON.parse(content[0].text)).not.toThrow();
  });

  it('marks oversized UTF-8 results as errors without emitting partial JSON', async () => {
    const client = await connect({ status: async () => ({ reason: '界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2) }), loop: async () => ({}) });
    const result = await client.callTool({ name: 'fleet_status' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });

  it('returns a generic tool error without leaking source exception details', async () => {
    const client = await connect({ status: async () => { throw new Error('private-source-value'); }, loop: async () => ({}) });
    const result = await client.callTool({ name: 'fleet_status' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
    expect(await client.listTools()).toHaveProperty('tools');
  });

  it('serves real fresh-home readers through the protocol without starting the fleet', async () => {
    const { readFleetStatus, readFleetLoop } = await import('../../src/mcp/fleet.js');
    const client = await connect({ status: readFleetStatus, loop: readFleetLoop });
    const result = await client.callTool({ name: 'fleet_status' });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('local-persisted');
  });
});

describe('fleet MCP CLI routing', () => {
  it('prints help and rejects arguments without starting a server', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMcp(['fleet', '--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('fleet_loop'));
    expect(await cmdMcp(['fleet', '--start'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith('Usage: phm mcp fleet\n');
  });

  it('routes the fleet entry to its isolated stdio adapter', async () => {
    const adapter = await import('../../src/mcp/fleet-server.js');
    const start = vi.spyOn(adapter, 'startFleetServer').mockResolvedValue();
    expect(await cmdMcp(['fleet'])).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  it('reports startup failure on stderr without exposing the source exception', async () => {
    const adapter = await import('../../src/mcp/fleet-server.js');
    vi.spyOn(adapter, 'startFleetServer').mockRejectedValue(new Error('private-startup-detail'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMcp(['fleet'])).toBe(1);
    expect(stderr).toHaveBeenCalledWith('[phm mcp fleet] server unavailable\n');
  });
});
