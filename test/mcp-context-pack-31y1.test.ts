import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContextServer, MAX_CONTEXT_PACK_BUDGET } from '../src/mcp/context-server.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';
import { cmdMcp } from '../src/cli/mcp.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createContextServer();
  const client = new Client({ name: 'context-test-model', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const fixture = {
  node: { jobId: 'review', upstreamJobIds: ['build'], query: 'routing' },
  outputs: [
    { jobId: 'unrelated', text: 'routing '.repeat(20) },
    { jobId: 'build', text: 'Built routing fix.' },
    { jobId: 'review', text: 'Do not retrieve own output.' },
  ],
  tasks: [
    { jobId: 'other', text: 'Garden maintenance.' },
    { jobId: 'build', text: 'Implement routing.' },
    { jobId: 'review', text: 'Review fix.' },
  ],
  byteBudget: 1000,
};

interface PackRow { jobId: string; kind: string; text: string; truncated: boolean }

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return content[0]!.text;
}
function rows(pack: string): PackRow[] {
  return pack ? pack.trimEnd().split('\n').map(line => JSON.parse(line) as PackRow) : [];
}

describe('context-pack MCP protocol', () => {
  it('negotiates a tools-only server and advertises exactly one read-only tool', async () => {
    const client = await connect();
    expect(client.getServerCapabilities()).toEqual({ tools: {} });
    expect(client.getServerVersion()?.name).toBe('phantom-context');
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['node_context_pack']);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools[0]!.inputSchema.additionalProperties).toBe(false);
  });

  it('returns the builder JSONL pack itself with upstream output first, own output excluded', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'node_context_pack', arguments: fixture });
    expect(result.isError).not.toBe(true);
    const pack = textOf(result);
    // No second escaped JSON wrapper: the MCP text IS the builder's JSONL output.
    expect(pack).toBe(buildNodeContextPack(fixture));
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(fixture.byteBudget);
    const lines = rows(pack);
    expect(lines.map(row => [row.jobId, row.kind])).toEqual([
      ['build', 'output'], ['build', 'task'], ['review', 'task'], ['unrelated', 'output'],
    ]);
    expect(lines.some(row => row.jobId === 'review' && row.kind === 'output')).toBe(false);
    // Every record cites its original complete jobId, never a truncated fragment.
    const supplied = new Set([...fixture.tasks, ...fixture.outputs].map(record => record.jobId));
    for (const row of lines) expect(supplied.has(row.jobId)).toBe(true);
  });

  it('bounds the pack to byteBudget with valid JSON lines under multibyte truncation', async () => {
    const client = await connect();
    const unicode = { ...fixture, tasks: [], outputs: [{ jobId: 'build', text: '🌍漢字"\\\n'.repeat(60) }], byteBudget: 300 };
    const result = await client.callTool({ name: 'node_context_pack', arguments: unicode });
    expect(result.isError).not.toBe(true);
    const pack = textOf(result);
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(300);
    const lines = rows(pack);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.jobId).toBe('build');
    expect(lines[0]!.truncated).toBe(true);
    expect(unicode.outputs[0]!.text.startsWith(lines[0]!.text)).toBe(true);
    expect(lines[0]!.text).not.toContain('\uFFFD');
  });

  it('succeeds with an empty pack for empty inputs or a budget that fits nothing', async () => {
    const client = await connect();
    const empty = await client.callTool({ name: 'node_context_pack', arguments: { ...fixture, tasks: [], outputs: [] } });
    expect(empty.isError).not.toBe(true);
    expect(textOf(empty)).toBe('');
    const tight = await client.callTool({ name: 'node_context_pack', arguments: { ...fixture, byteBudget: 1 } });
    expect(tight.isError).not.toBe(true);
    expect(textOf(tight)).toBe('');
  });

  it('accepts boundary sizes and omits optional query', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'node_context_pack', arguments: {
      node: { jobId: 'me', upstreamJobIds: ['up'] },
      // Aggregate text lands exactly on the 256 KiB cap.
      tasks: [{ jobId: 'me', text: 'x'.repeat(256 * 1024 - 14) }],
      outputs: [{ jobId: 'up', text: 'Upstream note.' }],
      byteBudget: MAX_CONTEXT_PACK_BUDGET,
    } });
    expect(result.isError).not.toBe(true);
    const lines = rows(textOf(result));
    expect(lines.map(row => [row.jobId, row.kind])).toEqual([['up', 'output'], ['me', 'task']]);
    expect(lines[1]!.truncated).toBe(true);
  });

  it.each([
    ['fleet_status', {}],
    ['node_context_pack', undefined],
    ['node_context_pack', {}],
    ['node_context_pack', { ...fixture, extra: 1 }],
    ['node_context_pack', { ...fixture, byteBudget: 0 }],
    ['node_context_pack', { ...fixture, byteBudget: -5 }],
    ['node_context_pack', { ...fixture, byteBudget: MAX_CONTEXT_PACK_BUDGET + 1 }],
    ['node_context_pack', { ...fixture, byteBudget: 1.5 }],
    ['node_context_pack', { ...fixture, byteBudget: NaN }],
    ['node_context_pack', { ...fixture, byteBudget: '1000' }],
    ['node_context_pack', { ...fixture, byteBudget: null }],
    ['node_context_pack', { ...fixture, node: 'x' }],
    ['node_context_pack', { ...fixture, node: { jobId: 'review' } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, zone: 'x' } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, jobId: 7 } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, jobId: 'j'.repeat(129) } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, upstreamJobIds: 'build' } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, upstreamJobIds: [7] } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, upstreamJobIds: Array(257).fill('j') } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, query: 5 } }],
    ['node_context_pack', { ...fixture, node: { ...fixture.node, query: 'q'.repeat(4097) } }],
    ['node_context_pack', { ...fixture, tasks: {} }],
    ['node_context_pack', { ...fixture, tasks: [{ jobId: 'b' }] }],
    ['node_context_pack', { ...fixture, tasks: [{ jobId: 'b', text: 't', kill: true }] }],
    ['node_context_pack', { ...fixture, tasks: [{ jobId: 'b', text: 9 }] }],
    ['node_context_pack', { ...fixture, tasks: [{ jobId: 'b'.repeat(129), text: 't' }] }],
    ['node_context_pack', { ...fixture, outputs: Array(257).fill({ jobId: 'j', text: 't' }) }],
    ['node_context_pack', { ...fixture, tasks: [{ jobId: 'b', text: 'x'.repeat(256 * 1024 + 1) }], outputs: [] }],
  ])('rejects malformed tools/arguments with InvalidParams: %s %j', async (name, args) => {
    const client = await connect();
    await expect(client.callTool({ name, arguments: args as Record<string, unknown> }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('redacts credential-shaped supplied text before packing, inside the byte budget', async () => {
    const fakeSecret = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const client = await connect();
    const result = await client.callTool({ name: 'node_context_pack', arguments: {
      node: { jobId: 'review', upstreamJobIds: ['build'] },
      tasks: [],
      outputs: [{ jobId: 'build', text: `token=${fakeSecret} under ${process.env.HOME}/repo done` }],
      byteBudget: 4000,
    } });
    expect(result.isError).not.toBe(true);
    const pack = textOf(result);
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
    expect(JSON.stringify(result)).not.toContain(process.env.HOME);
    expect(pack).toContain('REDACTED');
    const lines = rows(pack);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.jobId).toBe('build');
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(4000);
  });

  it('returns a generic tool error without leaking source exception details', async () => {
    const scrub = await import('../src/core/util/scrub.js');
    vi.spyOn(scrub, 'scrubPrivateText').mockImplementation(() => { throw new Error('private-source-value'); });
    const client = await connect();
    const result = await client.callTool({ name: 'node_context_pack', arguments: fixture });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
    expect(JSON.stringify(result)).not.toContain(fixture.node.jobId);
    expect(await client.listTools()).toHaveProperty('tools');
  });
});

describe('context MCP CLI routing', () => {
  it('prints help and rejects extra arguments without starting a server', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMcp(['context', '--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('node_context_pack'));
    expect(await cmdMcp(['context', '-h'])).toBe(0);
    expect(await cmdMcp(['context', '--watch'])).toBe(2);
    expect(await cmdMcp(['context', '--help', 'extra'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith('Usage: phm mcp context\n');
  });

  it('lists the context subcommand in general help', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMcp(['--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('node_context_pack'));
  });

  it('routes the context entry to its isolated stdio adapter without registry discovery', async () => {
    const adapter = await import('../src/mcp/context-server.js');
    const start = vi.spyOn(adapter, 'startContextServer').mockResolvedValue();
    const registry = await import('../src/core/mcp-registry.js');
    const discover = vi.spyOn(registry, 'discoverMcpServers');
    expect(await cmdMcp(['context'])).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(discover).not.toHaveBeenCalled();
  });

  it('reports startup failure on stderr without exposing the source exception', async () => {
    const adapter = await import('../src/mcp/context-server.js');
    vi.spyOn(adapter, 'startContextServer').mockRejectedValue(new Error('private-startup-detail'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMcp(['context'])).toBe(1);
    expect(stderr).toHaveBeenCalledWith('[phm mcp context] server unavailable\n');
  });

  it('leaves the fleet subcommand untouched', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMcp(['fleet', '--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('fleet_loop'));
  });
});
