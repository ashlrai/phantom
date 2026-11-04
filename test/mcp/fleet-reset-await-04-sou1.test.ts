import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetResetAwait, type FleetResetAwaitArgs } from '../../src/mcp/fleet-reset-await.js';
import type { awaitResetEvidence, ResetAwaitOutcome } from '../../src/core/fleet/reset-evidence-await.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(resetAwait?: FleetReaders['resetAwait']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reset-await-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), resetAwait }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

describe('fleet_reset_await', () => {
  it('advertises required bounded arguments and read-only evidence semantics', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(item => item.name === 'fleet_reset_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['lane', 'timeoutMs'], additionalProperties: false,
      properties: { lane: { type: 'string', pattern: '\\S' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 }, pollMs: { type: 'integer', minimum: 1, maximum: 60000 } } });
    expect(tool?.description).toMatch(/evidence only, not a release, lane health or successful launch/);
  });

  it('passes all outcomes through the projection and strips source metadata', async () => {
    for (const outcome of ['observed', 'deadline', 'failed', 'cancelled'] as ResetAwaitOutcome[]) {
      const fake = vi.fn(async () => ({ v: 1 as const, authority: 'none' as const, outcome, lane: '/fake/private/lane', checks: 2,
        evidence: { sourceState: 'healthy' as const, state: 'reset-detected' as const, heldBy: 'autobackoff' as const, readingAsOf: '2026-01-01T00:00:00.000Z', path: '/fake/source' }, source: '/fake/source' }));
      const client = await connect((input: FleetResetAwaitArgs) => readFleetResetAwait(input, fake as typeof awaitResetEvidence));
      const value = parse(await client.callTool({ name: 'fleet_reset_await', arguments: { lane: 'alpha', timeoutMs: 50 } }));
      expect(value).toEqual({ v: 1, authority: 'none', outcome, lane: '[path]', checks: 2,
        evidence: { sourceState: 'healthy', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: '2026-01-01T00:00:00.000Z' } });
      expect(fake).toHaveBeenCalledWith({ lane: 'alpha', timeoutMs: 50, pollMs: 50 });
    }
  });

  it('rejects malformed, out-of-bounds and root override arguments before reading', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const args of [ {}, { lane: '', timeoutMs: 1 }, { lane: '  ', timeoutMs: 1 }, { lane: null, timeoutMs: 1 },
      { lane: 'x', timeoutMs: null }, { lane: 'x', timeoutMs: 0 }, { lane: 'x', timeoutMs: 60001 },
      { lane: 'x', timeoutMs: 1.5 }, { lane: 'x', timeoutMs: '1' }, { lane: 'x', timeoutMs: 1, pollMs: null },
      { lane: 'x', timeoutMs: 1, pollMs: 2 }, { lane: 'x', timeoutMs: 1, pollMs: 0 },
      ...['runsDir', 'path', 'root', 'extra'].map(key => ({ lane: 'x', timeoutMs: 1, [key]: '/fake' })) ]) {
      await expect(client.callTool({ name: 'fleet_reset_await', arguments: args })).rejects.toThrow();
    }
    expect(reader).not.toHaveBeenCalled();
    await client.callTool({ name: 'fleet_reset_await', arguments: { lane: 'x', timeoutMs: 60000, pollMs: 60000 } });
    expect(reader).toHaveBeenCalledOnce();
  });
});
