import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, concludeFleetClaim, readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import { NOTE, readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let dir: string;
let ledger: string;
let client: Client;
let server: ReturnType<typeof createFleetServer>;
let now: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-return-414s-'));
  ledger = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  now = Date.now();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck({
      runtime: async () => ({ lastFleetStateRead: { ageSeconds: 0 } }),
      peers: () => ({ status: 'ok' }), now: () => now,
    }) });
  await server.connect(st);
  client = new Client({ name: 'bridge-return-414s', version: '1.0.0' });
  await client.connect(ct);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function bridge(live: number, privateValues: string[]) {
  const before = readFileSync(ledger);
  const result = await client.callTool({ name: 'fleet_bridge_check', arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  const value = JSON.parse(text);
  expect(value).toMatchObject({ verdict: 'READY', missing: [], asOf: new Date(now).toISOString(),
    claims: { status: 'ok', state: 'known', source: 'coordination-ledger', live,
      asOf: new Date(now).toISOString() } });
  if (live === 0) expect(value.claims.newestAgeSec).toBeNull();
  for (const secret of privateValues) expect(text.includes(secret)).toBe(false);
  expect(readFileSync(ledger)).toEqual(before);
  return value.asOf as string;
}

function claim(task: string) {
  const result = claimFleetWork({ repo: 'fake-org/fake-repo', task, agent: 'dot' }, { now });
  if (!result.ok) throw new Error(`claim failed: ${result.error}`);
  expect(statSync(ledger).mode & 0o077).toBe(0);
  return result.value;
}

describe('fleet_bridge_check real claim return (414s)', () => {
  it('keeps a rejected release live and immediately sees the owner release', async () => {
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_bridge_check');
    expect(tool?.description).toBe(NOTE);
    expect(tool?.description).toContain('READY is reachability, not work');
    const owned = claim('release lifecycle');
    const first = await bridge(1, [owned.lease]);
    now += 1000;
    expect(releaseFleetClaim({ id: owned.claim.id, agent: 'fake-owner', lease: owned.lease }, { now }))
      .toEqual({ ok: false, error: 'not-owner' });
    const rejected = await bridge(1, [owned.lease]);
    expect(Date.parse(rejected)).toBeGreaterThan(Date.parse(first));
    now += 1000;
    expect(releaseFleetClaim({ id: owned.claim.id, agent: 'dot', lease: owned.lease }).ok).toBe(true);
    const released = await bridge(0, [owned.lease]);
    expect(Date.parse(released)).toBeGreaterThan(Date.parse(rejected));
  });

  it('sees a returned claim disappear while retry posts exactly one result', async () => {
    const owned = claim('return lifecycle');
    const body = `temporary-result-${randomUUID()}`;
    const input = { id: owned.claim.id, agent: 'dot', lease: owned.lease,
      message: { id: randomUUID(), from: 'dot', to: 'fake-owner', body } };
    const first = await bridge(1, [owned.lease, body]);
    now += 1000;
    const intended = concludeFleetClaim(input, { now });
    expect(intended.ok && intended.value.outcome).toBe('intended');
    const returned = await bridge(0, [owned.lease, body]);
    expect(Date.parse(returned)).toBeGreaterThan(Date.parse(first));
    expect(readFleetBoard().messages).toHaveLength(0);
    now += 1000;
    const resolved = concludeFleetClaim(input, { now });
    expect(resolved.ok && resolved.value.outcome).toBe('resolved');
    const afterRetry = await bridge(0, [owned.lease, body]);
    expect(Date.parse(afterRetry)).toBeGreaterThan(Date.parse(returned));
    expect(readFleetBoard().messages).toMatchObject([{ id: input.message.id, body }]);
    now += 1000;
    const existing = concludeFleetClaim(input, { now });
    expect(existing.ok && existing.value.outcome).toBe('existing');
    await bridge(0, [owned.lease, body]);
    expect(readFleetBoard().messages).toHaveLength(1);
  });
});
