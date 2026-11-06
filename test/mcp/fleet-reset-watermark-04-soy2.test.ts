import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetResetAwait, type FleetResetAwaitArgs } from '../../src/mcp/fleet-reset-await.js';
import { awaitResetEvidence } from '../../src/core/fleet/reset-evidence-await.js';
import type { readUsageResets, UsageResetRow, UsageResetsV1 } from '../../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
// Persisted by the supervisor before it went offline; the reset is read after it.
const watermark = iso(start - 60_000);
const row = (over: Partial<UsageResetRow> = {}): UsageResetRow => ({ lane: 'alpha', held: true,
  heldReason: 'autobackoff usage', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 1, readingAsOf: iso(start - 30_000), resetAt: null,
  state: 'reset-detected', releasable: true, tell: 'reset observed', ...over });
const snapshot = (rows = [row()]): UsageResetsV1 => ({ v: 1, generatedAt: iso(start), sourceState: 'healthy', rows });
const now = () => Date.now() - start;
const args = { lane: 'alpha', timeoutMs: 100, pollMs: 20 };

const clients: Client[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(resetAwait?: FleetReaders['resetAwait']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reset-watermark-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), resetAwait }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
// The real waiter behind the transport, with an injected source and clock instead of disk and wall time.
const realWaiter = (read: typeof readUsageResets) =>
  (input: FleetResetAwaitArgs) => readFleetResetAwait(input, options => awaitResetEvidence(options, { read, now }));

describe('fleet_reset_await after watermark', () => {
  it('advertises the optional after watermark and keeps required fields and unknown-key rejection', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(item => item.name === 'fleet_reset_await');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['lane', 'timeoutMs'], additionalProperties: false,
      properties: { after: { type: 'string', format: 'date-time' } } });
    expect(tool?.description).toMatch(/Pass a saved after watermark/);
    expect(tool?.description).toMatch(/evidence only, not a release, lane health or successful launch/);
  });

  it('passes a supplied watermark to the reader exactly as sent', async () => {
    const reader = vi.fn(async () => ({ v: 1 }));
    const client = await connect(reader);
    // Non-normalized offset form: the transport must not rewrite it.
    const after = '2026-11-01T01:59:00+02:00';
    await client.callTool({ name: 'fleet_reset_await', arguments: { ...args, after } });
    expect(reader).toHaveBeenCalledWith({ lane: 'alpha', timeoutMs: 100, pollMs: 20, after });
  });

  it('keeps the existing argument shape when after is omitted', async () => {
    const reader = vi.fn(async () => ({ v: 1 }));
    const client = await connect(reader);
    await client.callTool({ name: 'fleet_reset_await', arguments: args });
    expect(reader).toHaveBeenCalledOnce();
    expect(reader.mock.calls[0]?.[0]).toEqual({ lane: 'alpha', timeoutMs: 100, pollMs: 20 });
    expect(reader.mock.calls[0]?.[0]).not.toHaveProperty('after');
  });

  it.each([
    5, null, '', '   ', 'yesterday', '2026-11-01T00:00:00', '2026-11-01 00:00:00Z', '2026-11-01T00:00:00+0200', '2026-13-01T00:00:00Z',
  ])('rejects malformed or wrong-typed after=%j before reading', async after => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_reset_await', arguments: { ...args, after } })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('observes evidence after the saved watermark and before invocation resolves, through the real waiter', async () => {
    const source = vi.fn(async () => snapshot([row({ readingAsOf: iso(start - 30_000) })]));
    const client = await connect(realWaiter(source));
    const value = parse(await client.callTool({ name: 'fleet_reset_await', arguments: { ...args, after: watermark } }));
    expect(value).toEqual({ v: 1, authority: 'none', outcome: 'observed', lane: 'alpha', checks: 1,
      evidence: { sourceState: 'healthy', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: iso(start - 30_000) } });
    expect(source).toHaveBeenCalledOnce();
  });

  it('observes a later poll that lands after the watermark while the call is still pending', async () => {
    const source = vi.fn()
      .mockResolvedValueOnce(snapshot([row({ readingAsOf: watermark })]))
      .mockResolvedValue(snapshot([row({ readingAsOf: iso(start - 10_000) })]));
    const client = await connect(realWaiter(source));
    const pending = client.callTool({ name: 'fleet_reset_await', arguments: { ...args, after: watermark } });
    await vi.advanceTimersByTimeAsync(20);
    expect(parse(await pending)).toMatchObject({ outcome: 'observed', checks: 2, authority: 'none' });
  });

  it('keeps the invocation boundary through the real waiter when after is omitted', async () => {
    const source = vi.fn(async () => snapshot([row({ readingAsOf: iso(start - 30_000) })]));
    const client = await connect(realWaiter(source));
    const pending = client.callTool({ name: 'fleet_reset_await', arguments: args });
    await vi.advanceTimersByTimeAsync(100);
    expect(parse(await pending)).toMatchObject({ outcome: 'deadline', authority: 'none',
      evidence: { state: 'reset-detected', readingAsOf: iso(start - 30_000) } });
  });

  it.each([
    ['equal to the watermark', iso(start - 60_000)],
    ['older than the watermark', iso(start - 90_000)],
    ['after invocation', iso(start + 60_000)],
  ])('does not observe %s evidence', async (_label, readingAsOf) => {
    const source = vi.fn(async () => snapshot([row({ readingAsOf })]));
    const client = await connect(realWaiter(source));
    const pending = client.callTool({ name: 'fleet_reset_await', arguments: { ...args, after: watermark } });
    await vi.advanceTimersByTimeAsync(100);
    expect(parse(await pending)).toMatchObject({ outcome: 'deadline', authority: 'none' });
    expect(source).toHaveBeenCalled();
  });
});
