import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetResetHistory, type FleetResetHistoryArgs } from '../../src/mcp/fleet-reset-history.js';
import type { readResetReleases, ResetReleaseRecord } from '../../src/core/fleet/usage-reset-release.js';

const connections: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function connect(resetHistory?: FleetReaders['resetHistory'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reset-history-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, resetHistory }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

/** The injected projection: the server's reader slot with a fake audit reader inside. */
const fakeHistory = (read: typeof readResetReleases) =>
  (input: FleetResetHistoryArgs) => readFleetResetHistory(input, { read });

const record = (over: Partial<ResetReleaseRecord>): ResetReleaseRecord => ({
  v: 1, lane: 'claude', at: '2026-11-03T10:00:00Z', state: 'reset-detected',
  usedPct: 4, readingAsOf: '2026-11-03T09:00:00Z', heldUntil: '2026-11-04T00:00:00Z',
  by: 'reset-detect', reason: 'window reset: reads 4%', ...over,
});

describe('fleet_reset_history over MCP', () => {
  it('is advertised read-only with a bounded limit and exact-lane schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_reset_history');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
        lane: { type: 'string', description: expect.stringContaining('Exact') },
      },
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/recorded autobackoff release history/i);
    expect(tool?.description).toMatch(/never a live lane-health or launch-success verdict/i);
    expect(tool?.description).toMatch(/not that the source is healthy/i);
  });

  it('returns newest-first records filtered by exact lane before the limit', async () => {
    const rows = [
      record({ lane: 'alpha', at: 't6' }), record({ lane: 'beta', at: 't5' }),
      record({ lane: 'alpha', at: 't4' }), record({ lane: 'beta', at: 't3' }),
      record({ lane: 'alpha', at: 't2' }), record({ lane: 'beta', at: 't1' }),
    ];
    const read = vi.fn(async () => rows);
    const client = await connect(fakeHistory(read));
    const filtered = parse(await client.callTool({ name: 'fleet_reset_history', arguments: { lane: 'alpha', limit: 2 } }));
    expect(read).toHaveBeenLastCalledWith(undefined, 200);
    expect(filtered.records.map((row: { at: string }) => row.at)).toEqual(['t6', 't4']);
    const all = parse(await client.callTool({ name: 'fleet_reset_history' }));
    expect(read).toHaveBeenLastCalledWith(undefined, 20);
    expect(all.records.map((row: { at: string }) => row.at)).toEqual(['t6', 't5', 't4', 't3', 't2', 't1']);
  });

  it('passes default and explicit limits to the bounded read at the default root', async () => {
    const read = vi.fn(async () => [record({})]);
    const client = await connect(fakeHistory(read));
    const out = parse(await client.callTool({ name: 'fleet_reset_history', arguments: { limit: 3 } }));
    expect(read).toHaveBeenLastCalledWith(undefined, 3);
    expect(out.records).toHaveLength(1);
  });

  it('projects only public fields and drops by, reason, v and unknown fields', async () => {
    const secret = 'sk-test-' + 'FAKEFAKE'.repeat(4);
    const rows = [{
      ...record({ lane: 'evil lane', at: '/private/evil/at', readingAsOf: secret, state: 'hold-expired' as const }),
      reason: `token ${secret}`, extra: '/private/evil/extra',
    } as ResetReleaseRecord];
    const client = await connect(fakeHistory(async () => rows));
    const out = parse(await client.callTool({ name: 'fleet_reset_history', arguments: { limit: 1 } }));
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none' });
    expect(Object.keys(out.records[0]).sort()).toEqual(['at', 'heldUntil', 'lane', 'readingAsOf', 'state', 'usedPct']);
    expect(out.records[0].at).toBe('[path]');
    expect(out.records[0].state).toBe('hold-expired');
    const text = JSON.stringify(out);
    for (const leak of [secret, '/private/evil', 'reason', '"by"', '"v"', 'extra']) expect(text).not.toContain(leak);
  });

  it('documents that empty history proves nothing about source health', async () => {
    const client = await connect(fakeHistory(async () => []));
    const out = parse(await client.callTool({ name: 'fleet_reset_history' }));
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', records: [] });
    expect(out.note).toMatch(/not that the source is healthy/i);
    expect(JSON.stringify(out)).not.toContain('sourceState');
  });

  it('serves the real default reader against the configured root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reset-history-mcp-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue', 'reset-releases.jsonl'),
      `${JSON.stringify({ lane: 'claude', at: '2026-11-03T10:00:00Z', state: 'hold-expired', usedPct: 9, readingAsOf: '2026-11-03T09:00:00Z', heldUntil: '2026-11-03T08:00:00Z', reason: 'do-not-forward' })}\n`);
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const client = await connect();
    const out = parse(await client.callTool({ name: 'fleet_reset_history' }));
    expect(out.records).toEqual([{
      lane: 'claude', at: '2026-11-03T10:00:00Z', state: 'hold-expired',
      usedPct: 9, readingAsOf: '2026-11-03T09:00:00Z', heldUntil: '2026-11-03T08:00:00Z',
    }]);
    expect(JSON.stringify(out)).not.toContain('do-not-forward');
  });

  it.each([
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '2' }, { limit: null },
    { lane: 5 }, { lane: null }, { lane: 'a', extra: 1 },
    { runsDir: '/tmp/x' }, { root: '/tmp/x' }, { path: '/tmp/x' },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_reset_history', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('sanitizes reader failures instead of forwarding source details', async () => {
    const client = await connect(async () => { throw new Error('token ghp_secret /Users/me'); });
    const result = await client.callTool({ name: 'fleet_reset_history' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|\/Users/);
  });

  it('keeps unknown-tool rejection and leaves existing tools working', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_release' })).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'fleet_release', arguments: { lane: 'claude' } })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 2 });
  });
});
