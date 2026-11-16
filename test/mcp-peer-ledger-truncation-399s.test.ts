import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { NOTE, readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const name = 'fleet_peer_ledger';
const T0 = Date.parse('2026-11-15T13:00:00.000Z');
const MAX_PAIRS = 64, MAX_ORIGINS = 32;
const THREAD = 'fixture-399s-private-thread';
const THREAD2 = 'fixture-399s-second-thread';
const DIGEST = '3995a1b2'.repeat(8);
const DIGEST2 = 'b2a15993'.repeat(8);
const ORIGIN_SAT = 'peer-3995a1b2-3995-4995-8995-399539953995';
const ORIGIN_REST = 'peer-3995ffff-3995-4995-8995-399539953995';
const ORIGIN_NEW = 'peer-3995bbbb-3995-4995-8995-399539953995';
const midOrigin = (i: number) => `peer-39950000-3995-4995-8995-${String(i).padStart(12, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();
const pad = (i: number) => String(i).padStart(2, '0');
const REPORT_KEYS = ['asOf', 'authority', 'capacity', 'liveRows', 'maxHops', 'note',
  'origins', 'pairLimit', 'pairs', 'status', 'truncated', 'v', 'windowMs'];
const PAIR_KEYS = ['fromAgent', 'inWindow', 'lastAt', 'remaining', 'retryAt', 'target'];

let client: Client;
let server: ReturnType<typeof createFleetServer>;
let busRoot: string;
let dir: string;
let file: string;
let nowMs: number;
let seq: number;

// Pass-through spy: the real reader over the private bus root, counted not mocked.
const reader = vi.fn(() => readPeerLedger({ busRoot, now: () => nowMs }));

beforeEach(async () => {
  nowMs = T0;
  seq = 0;
  reader.mockClear();
  busRoot = realpathSync(mkdtempSync(join(tmpdir(), 'peer-ledger-399s-')));
  dir = join(busRoot, 'agentnet');
  file = join(dir, 'coordination.json');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    peerLedger: () => readFleetPeerLedger({ read: reader }) });
  await server.connect(st);
  client = new Client({ name: 'peer-ledger-399s', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  if (busRoot) rmSync(busRoot, { recursive: true, force: true });
});

const row = (input: { from: string; target: string; origin: string; at: number;
  hop?: number; digest?: string; thread?: string }) => ({
  id: `peer-3995a1b2-3995-4995-8995-${String(++seq).padStart(12, '0')}`,
  fromAgent: input.from, target: input.target, origin: input.origin,
  digest: input.digest ?? DIGEST, hopCount: input.hop ?? 1,
  threadId: input.thread ?? THREAD, at: input.at,
});

const writeRows = (rows: unknown[]) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(rows));
  chmodSync(file, 0o600);
};

const call = async () => {
  const result = await client.callTool({ name, arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, value: JSON.parse(text) as PeerLedgerReport & { note: string } };
};

// Evidence is metadata-only: no filesystem paths, stored thread ids, digests
// or internal reader error text may cross the tool boundary, in any state.
const expectNoPrivateDetail = (text: string) => {
  for (const detail of [busRoot, dir, file, THREAD, THREAD2, DIGEST, DIGEST2, 'peer-storage-unavailable']) {
    expect(text).not.toContain(detail);
  }
};

// 75 rows, well under the 1024 capacity, that overflow both display limits:
// 70 pairs (one saturated, 50 in-window, 19 live but out of window) and 41
// origins (one at the near-hop-cap boundary, 40 at hop 1).
const seedRows = () => [
  ...Array.from({ length: PEER_PAIR_LIMIT }, (_, i) => row({
    from: 'sat-src', target: 'agent-sat', origin: ORIGIN_SAT,
    hop: PEER_MAX_HOPS - 1, at: T0 - 30_000 + i * 1_000 })),
  ...Array.from({ length: 50 }, (_, i) => row({
    from: 'mid-src', target: `agent-m${pad(i)}`,
    origin: i < 39 ? midOrigin(i) : ORIGIN_REST, at: T0 - 10_000 })),
  ...Array.from({ length: 19 }, (_, i) => row({
    from: 'cold-src', target: `agent-c${pad(i)}`, origin: ORIGIN_REST, at: T0 - 120_000 })),
];

describe('fleet peer ledger MCP truncation (399s)', () => {
  it('serves honest partial evidence at the caps, then a fresh small report on the same connection', async () => {
    writeRows(seedRows());
    const partial = await call();
    expect(Object.keys(partial.value).sort()).toEqual(REPORT_KEYS);
    expect(partial.value).toMatchObject({ v: 1, authority: 'none', status: 'ok', asOf: iso(T0),
      liveRows: 75, capacity: 1024, windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT,
      maxHops: PEER_MAX_HOPS, truncated: { pairs: true, origins: true }, note: NOTE });
    expect(partial.value.pairs).toHaveLength(MAX_PAIRS);
    expect(partial.value.origins).toHaveLength(MAX_ORIGINS);
    expect(Object.keys(partial.value.pairs[0]!).sort()).toEqual(PAIR_KEYS);
    // Tightest budget first, ties by target: the saturated pair, then the
    // in-window mid pairs, then the out-of-window cold pairs through the cap.
    expect(partial.value.pairs.map(p => p.target)).toEqual(
      ['agent-sat', ...Array.from({ length: 50 }, (_, i) => `agent-m${pad(i)}`),
        ...Array.from({ length: 13 }, (_, i) => `agent-c${pad(i)}`)]);
    expect(partial.value.pairs[0]).toEqual({ fromAgent: 'sat-src', target: 'agent-sat',
      inWindow: PEER_PAIR_LIMIT, remaining: 0, lastAt: iso(T0 - 25_000), retryAt: iso(T0 + 30_000) });
    expect(partial.value.pairs[MAX_PAIRS - 1]).toEqual({ fromAgent: 'cold-src', target: 'agent-c12',
      inWindow: 0, remaining: PEER_PAIR_LIMIT, lastAt: iso(T0 - 120_000), retryAt: null });
    // The near-hop-cap origin leads; the rest are hop-1 in id order through the cap.
    expect(partial.value.origins[0]).toEqual({ origin: ORIGIN_SAT, maxHop: PEER_MAX_HOPS - 1, nearCap: true });
    expect(partial.value.origins.slice(1)).toEqual(
      Array.from({ length: MAX_ORIGINS - 1 }, (_, i) => ({ origin: midOrigin(i), maxHop: 1, nearCap: false })));
    // Everything past the caps is absent from the wire, not hidden by flags alone.
    for (const dropped of ['agent-c13', 'agent-c18', midOrigin(31), ORIGIN_REST]) {
      expect(partial.text).not.toContain(dropped);
    }
    expectNoPrivateDetail(partial.text);

    // Rewriting private disk to one entirely different pair and origin replaces
    // the board completely on the same connection: flags clear, nothing stale.
    writeRows([row({ from: 'fresh-src', target: 'agent-new', origin: ORIGIN_NEW,
      digest: DIGEST2, thread: THREAD2, at: T0 - 5_000 })]);
    nowMs = T0 + 45_000;
    const fresh = await call();
    expect(fresh.value).toMatchObject({ v: 1, authority: 'none', status: 'ok', asOf: iso(nowMs),
      liveRows: 1, note: NOTE,
      pairs: [{ fromAgent: 'fresh-src', target: 'agent-new', inWindow: 1,
        remaining: PEER_PAIR_LIMIT - 1, lastAt: iso(T0 - 5_000), retryAt: null }],
      origins: [{ origin: ORIGIN_NEW, maxHop: 1, nearCap: false }],
      truncated: { pairs: false, origins: false } });
    expect(Object.keys(fresh.value).sort()).toEqual(REPORT_KEYS);
    for (const stale of ['sat-src', 'mid-src', 'cold-src', 'agent-sat', 'agent-m00', 'agent-c00',
      ORIGIN_SAT, midOrigin(0)]) {
      expect(fresh.text).not.toContain(stale);
    }
    expectNoPrivateDetail(fresh.text);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('refuses a caller-supplied root without invoking the reader', async () => {
    await expect(client.callTool({ name, arguments: { root: busRoot } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });
});
