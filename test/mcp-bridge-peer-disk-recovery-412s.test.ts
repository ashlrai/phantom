import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PEER_PAIR_LIMIT, PEER_WINDOW_MS, rowSchema } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const PRIVATE = 'fixture-private-malformed-412s';
const origin = 'peer-4125a1b2-4125-4125-8125-412541254125';
const iso = (ms: number) => new Date(ms).toISOString();
let root: string;
let file: string;
let now: number;
let client: Client;
let server: ReturnType<typeof createFleetServer>;

beforeEach(async () => {
  now = T0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-peer-412s-')));
  const dir = join(root, 'agentnet');
  mkdirSync(dir, { mode: 0o700 });
  file = join(dir, 'coordination.json');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck({
      runtime: async () => ({ lastFleetStateRead: { ageSeconds: 30 } }),
      claims: () => ({ state: 'known', claims: [] }),
      peers: () => readFleetPeerLedger({ read: () => readPeerLedger({ busRoot: root, now: () => now }) }),
      now: () => now,
    }) });
  await server.connect(st);
  client = new Client({ name: 'bridge-peer-412s', version: '1.0.0' });
  await client.connect(ct);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function row(index: number, at: number) {
  return rowSchema.parse({ id: `peer-4125a1b2-4125-4125-8125-${String(index).padStart(12, '0')}`,
    fromAgent: 'fixture-dot', target: 'fixture-leader', origin, digest: 'a'.repeat(64),
    hopCount: 1, threadId: 'fixture-private-thread', at });
}

function write(contents: string) {
  writeFileSync(file, contents, { mode: 0o600 });
}

async function call() {
  const before = readFileSync(file);
  const result = await client.callTool({ name: 'fleet_bridge_check', arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  expect(readFileSync(file)).toEqual(before);
  expect(text).not.toContain(PRIVATE);
  expect(text).not.toContain(root);
  expect(text).not.toContain('fixture-private-thread');
  return JSON.parse(text);
}

describe('fleet bridge peer disk recovery (412s)', () => {
  it('fails closed on corrupt peer evidence and refreshes the real budget on the same connection', async () => {
    write(JSON.stringify([row(1, T0 - 1_000)]));
    expect(await call()).toMatchObject({ verdict: 'READY', missing: [], peers: {
      status: 'ok', authority: 'none', liveRows: 1, asOf: iso(T0),
      pairs: [{ fromAgent: 'fixture-dot', target: 'fixture-leader', inWindow: 1,
        remaining: PEER_PAIR_LIMIT - 1, retryAt: null }],
    } });

    write(PRIVATE);
    expect(await call()).toMatchObject({ verdict: 'BLOCKED', missing: ['peers'], peers: {
      status: 'unavailable', reason: 'peer-ledger-unreadable', liveRows: 0, pairs: [],
    } });

    const retryAt = T0 + 1_000;
    const ats = Array.from({ length: PEER_PAIR_LIMIT }, (_, i) => retryAt - PEER_WINDOW_MS + i * 1_000);
    write(JSON.stringify(ats.map((at, i) => row(i + 1, at))));
    expect(await call()).toMatchObject({ verdict: 'READY', missing: [], peers: {
      status: 'ok', authority: 'none', liveRows: PEER_PAIR_LIMIT, asOf: iso(T0),
      pairs: [{ fromAgent: 'fixture-dot', target: 'fixture-leader', inWindow: PEER_PAIR_LIMIT,
        remaining: 0, retryAt: iso(retryAt) }],
    } });

    now = retryAt;
    expect(await call()).toMatchObject({ verdict: 'READY', missing: [], peers: {
      status: 'ok', asOf: iso(retryAt), liveRows: PEER_PAIR_LIMIT,
      pairs: [{ fromAgent: 'fixture-dot', target: 'fixture-leader', inWindow: PEER_PAIR_LIMIT - 1,
        remaining: 1, retryAt: null }],
    } });
  });
});
