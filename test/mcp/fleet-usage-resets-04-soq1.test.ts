import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetUsageResets } from '../../src/mcp/fleet-usage-resets.js';
import { detectUsageResets, type UsageResetsV1 } from '../../src/core/fleet/usage-reset-detect.js';
import type { LaneTargetRow } from '../../src/core/fleet/runs-lane-targets.js';
import type { ResourceLaneRow } from '../../src/core/fleet/runs-resource-ledger.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(usageResets?: FleetReaders['usageResets']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'resets-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), usageResets }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

const NOW = Date.parse('2026-11-03T12:00:00Z');
const lane = (over: Partial<LaneTargetRow>): LaneTargetRow => ({
  lane: 'claude', target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...over,
});
const reading = (over: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane: 'claude', running: 0, target: 2, held: true, window: 'weekly', usedPct: 5, creditsRemaining: null,
  resetAt: '2026-11-10T00:00:00Z', burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
  source: null, deadSignal: null, ...over,
});
function detected(lanes: LaneTargetRow[], ledger: ResourceLaneRow[], sourceState: UsageResetsV1['sourceState'] = 'healthy'): () => Promise<UsageResetsV1> {
  return async () => ({
    v: 1, generatedAt: new Date(NOW).toISOString(), sourceState,
    rows: detectUsageResets({ lanes, ledger, ledgerAsOf: '2026-11-03T11:00:00Z', nowMs: NOW }),
  });
}
const heldLane = (over: Partial<LaneTargetRow> = {}) => lane({
  held: true, heldReason: 'autobackoff: weekly usage limit', heldUntil: '2026-11-04T00:00:00Z',
  lastChange: '2026-11-02T00:00:00Z', ...over,
});

describe('fleet_usage_resets over MCP', () => {
  it('is advertised observation-only with an empty strict schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_usage_resets');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool?.description).toMatch(/never authorizes a release/);
  });

  it('returns real detector evidence for reset, manual and stale holds without raw reasons', async () => {
    const lanes = [
      heldLane(), heldLane({ lane: 'codex' }),
      lane({ lane: 'gemini', held: true, heldReason: 'operator pause token=abc', lastChange: '2026-11-02T00:00:00Z' }),
    ];
    const ledger = [
      reading({}),
      reading({ lane: 'codex', observation: { source: 'claude-native-usage', asOf: '2026-11-01T00:00:00Z' } }),
    ];
    const client = await connect(() => readFleetUsageResets(detected(lanes, ledger)));
    const out = parse(await client.callTool({ name: 'fleet_usage_resets' }));
    expect(out).toMatchObject({ schemaVersion: 1, authority: 'none', sourceState: 'healthy', generatedAt: '2026-11-03T12:00:00.000Z' });
    const by = Object.fromEntries(out.rows.map((r: { lane: string }) => [r.lane, r]));
    expect(by.claude).toEqual({
      lane: 'claude', state: 'reset-detected', held: true, heldBy: 'autobackoff', heldUntil: '2026-11-04T00:00:00Z',
      usedPct: 5, readingAsOf: '2026-11-03T11:00:00Z', resetAt: '2026-11-10T00:00:00Z', releasable: true,
    });
    expect(by.codex).toMatchObject({ state: 'stale-reading', releasable: false });
    expect(by.gemini).toMatchObject({ state: 'manual-hold', heldBy: 'manual', releasable: false });
    expect(JSON.stringify(out)).not.toMatch(/heldReason|tell|autobackoff:|operator pause/);
  });

  it('keeps missing and degraded evidence explicit and never releasable', async () => {
    const lanes = [heldLane()];
    for (const state of ['missing', 'degraded'] as const) {
      const client = await connect(() => readFleetUsageResets(detected(lanes, [reading({})], state)));
      const out = parse(await client.callTool({ name: 'fleet_usage_resets' }));
      expect(out.sourceState).toBe(state);
      expect(out.rows[0]).toMatchObject({ state: 'reset-detected', releasable: false });
    }
    const failing = await readFleetUsageResets(async () => { throw new Error('/Users/x/secret'); });
    expect(failing).toMatchObject({ sourceState: 'degraded', rows: [] });
  });

  it('drops unknown fields and malformed rows, marking the source degraded', async () => {
    const out = await readFleetUsageResets(async () => ({
      v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy', future: 'x',
      rows: [
        { lane: 'a', state: 'open', held: false, heldBy: null, heldUntil: null, usedPct: 1, readingAsOf: null, resetAt: null, releasable: false, heldReason: 'r', extra: 1 },
        { lane: 'b', state: 'bogus' },
      ],
    } as unknown as UsageResetsV1));
    expect(out.sourceState).toBe('degraded');
    expect(out.rows).toHaveLength(1);
    expect(Object.keys(out.rows[0]).sort()).toEqual(['held', 'heldBy', 'heldUntil', 'lane', 'readingAsOf', 'releasable', 'resetAt', 'state', 'usedPct']);
    expect(JSON.stringify(out)).not.toContain('future');
  });

  it.each([{ path: '/tmp/x' }, { runsDir: '/tmp/x' }, { apply: true }, { dryRun: false }, { limit: 1 }])(
    'rejects arguments before any read: %j', async args => {
      const reader = vi.fn(async () => ({}));
      const client = await connect(reader);
      await expect(client.callTool({ name: 'fleet_usage_resets', arguments: args })).rejects.toMatchObject({ code: -32602 });
      expect(reader).not.toHaveBeenCalled();
    });

  it('redacts reader exceptions', async () => {
    const client = await connect(async () => { throw new Error('token ghp_secret /Users/me/.ashlr'); });
    const result = await client.callTool({ name: 'fleet_usage_resets' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|\/Users/);
  });

  it('fails oversized output explicitly instead of truncating', async () => {
    const client = await connect(async () => ({ pad: '界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2) }));
    const result = await client.callTool({ name: 'fleet_usage_resets' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/exceeds the output limit/);
  });
});
