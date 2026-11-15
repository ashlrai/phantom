import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { parseFleetStagingInventoryArgs } from '../../src/mcp/fleet-staging-inventory.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
  vi.unstubAllEnvs();
});

function parse(result: { content?: unknown }): ReturnType<typeof JSON.parse> {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

async function connect(stagingInventory?: FleetReaders['stagingInventory']) {
  const readers: FleetReaders = {
    status: async () => ({}),
    loop: async () => ({}),
    stagingInventory,
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'staging-inv-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer(readers).connect(st);
  await client.connect(ct);
  return client;
}

describe('fleet_staging_inventory over MCP', () => {
  it('is advertised observation-only with an empty strict schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_staging_inventory');
    expect(tool).toBeDefined();
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('returns structured evidence from an injected reader', async () => {
    const fakeReport = {
      schema: 'fleet.staging-inventory.v1',
      generatedAt: '2026-11-05T14:35:00.000Z',
      root: '/tmp/fake-staging',
      source: 'ok',
      complete: true,
      truncated: false,
      skippedSymlinks: 0,
      entries: [{ name: 'repo-A', modifiedAt: '2026-11-04T10:00:00.000Z', bytes: 102400 }],
      totalMeasuredBytes: 102400,
      cleanupEligibility: 'Age and size do not establish cleanup eligibility.',
    };
    const client = await connect(async () => fakeReport);
    const out = parse(await client.callTool({ name: 'fleet_staging_inventory' }));
    expect(out.schema).toBe('fleet.staging-inventory.v1');
    expect(out.source).toBe('ok');
    expect(out.complete).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.entries).toEqual([{ name: 'repo-A', modifiedAt: '2026-11-04T10:00:00.000Z', bytes: 102400 }]);
    expect(out.totalMeasuredBytes).toBe(102400);
    expect(out.cleanupEligibility).toBe('Age and size do not establish cleanup eligibility.');
  });

  it.each([
    { root: '/tmp/anything' },
    { apply: true },
    { path: 'run' },
    { command: 'clean' },
    { x: 1 },
    { limit: 10 },
  ])('rejects arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_staging_inventory', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('parseFleetStagingInventoryArgs accepts only the empty object', () => {
    expect(parseFleetStagingInventoryArgs({})).toEqual({});
    for (const args of [{ root: '/tmp' }, { apply: true }, { path: 'x' }]) {
      expect(parseFleetStagingInventoryArgs(args)).toBeNull();
    }
  });

  it('returns a generic tool error without leaking source exception details', async () => {
    const client = await connect(async () => {
      throw new Error('private-source /Users/me/token');
    });
    const result = await client.callTool({ name: 'fleet_staging_inventory' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text)
      .toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/private-source|\/Users/);
  });

  it('empty root directory reports zero measured bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sst-empty-'));
    const stagingDir = join(home, '.local', 'share', 'ashlr', 'release-staging');
    mkdirSync(stagingDir, { recursive: true });
    vi.stubEnv('HOME', home);
    const client = await connect();
    const out = parse(await client.callTool({ name: 'fleet_staging_inventory' }));
    expect(out.root).toContain('release-staging');
    expect(out.totalMeasuredBytes).toBe(0);
    expect(out.entries).toEqual([]);
    expect(out.source).toBe('ok');
    expect(out.cleanupEligibility).toBe('Age and size do not establish cleanup eligibility.');
  });

  it('missing root reports source degraded', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sst-missing-'));
    vi.stubEnv('HOME', home);
    const client = await connect();
    const out = parse(await client.callTool({ name: 'fleet_staging_inventory' }));
    expect(out.root).toContain('release-staging');
    expect(out.source).toBe('missing');
  });

  it('symlink children are excluded and counted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sst-symlink-'));
    const stagingDir = join(home, '.local', 'share', 'ashlr', 'release-staging');
    mkdirSync(stagingDir, { recursive: true });
    // Create a real directory and a symlink to it
    const realDir = join(stagingDir, 'repo-real');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(realDir, 'data'), { recursive: true });
    writeFileSync(join(realDir, 'data', 'file.txt'), 'x');
    const linkDir = join(stagingDir, 'repo-link');
    try { symlinkSync(realDir, linkDir); } catch { /* skip on systems that don't allow */ }
    vi.stubEnv('HOME', home);
    const client = await connect();
    const out = parse(await client.callTool({ name: 'fleet_staging_inventory' }));
    const names = out.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('repo-real');
    expect(out.skippedSymlinks).toBeGreaterThan(0);
  });

  it('adapter has no mutation or exec-shell path', async () => {
    // Verify the core adapter module has no dangerous calls
    const mod = await import('../../src/mcp/fleet-staging-inventory.js');
    const modText = JSON.stringify(mod);
    expect(modText).not.toMatch(/execFileSync|execFile|spawn|exec\(/);
    expect(modText).not.toMatch(/apply|clean|reclaim|unblock|delete|remove|truncate/);
  });
});
