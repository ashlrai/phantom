import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_PAIR_LIMIT } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport, type PeerPairSelector } from '../src/core/agentnet/peer-ledger.js';
import { NOTE, readFleetPeerLedger, type FleetPeerLedgerArgs } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const name = 'fleet_peer_ledger';
const T0 = Date.parse('2026-11-15T14:00:00.000Z');
const MAX_PAIRS = 64;
const THREAD = 'fixture-402s-private-thread';
const DIGEST = '4025a1b2'.repeat(8);
const ORIGIN = 'peer-4025a1b2-4025-4402-8402-402540254025';
const CORRUPT = 'fixture-402s-corrupt-bytes';
const iso = (ms: number) => new Date(ms).toISOString();

let client: Client;
let server: ReturnType<typeof createFleetServer>;
let busRoot: string, dir: string, file: string, nowMs: number, seq: number;

// Pass-through spy: the real reader over the private bus root, counted not mocked.
const reader = vi.fn((pair?: PeerPairSelector) => readPeerLedger({ busRoot, pair, now: () => nowMs }));

beforeEach(async () => {
  nowMs = T0; seq = 0; reader.mockClear();
  busRoot = realpathSync(mkdtempSync(join(tmpdir(), 'peer-ledger-402s-')));
  dir = join(busRoot, 'agentnet'); file = join(dir, 'coordination.json');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    peerLedger: (input: FleetPeerLedgerArgs) => readFleetPeerLedger({ ...input, read: reader }) });
  await server.connect(st);
  client = new Client({ name: 'peer-ledger-402s', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close(); await server?.close();
  if (busRoot) rmSync(busRoot, { recursive: true, force: true });
});

const row = (input: { from: string; target: string; at: number }) => ({
  id: `peer-4025a1b2-4025-4402-8402-${String(++seq).padStart(12, '0')}`,
  fromAgent: input.from, target: input.target, origin: ORIGIN,
  digest: DIGEST, hopCount: 1, threadId: THREAD, at: input.at,
});
const writeRows = (rows: unknown[]) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(rows));
  chmodSync(file, 0o600);
};

// 65 live pairs: 64 saturated 'a-src' pairs fill the entire display slice; the
// queried 'z-src' pair ties on budget and sorts past the cap, so an unfiltered
// call can never show it. retryAt for z-src = oldest row + window = T0+50_500.
const seedRows = () => [
  ...Array.from({ length: MAX_PAIRS }, (_, p) => Array.from({ length: PEER_PAIR_LIMIT }, (_, i) =>
    row({ from: 'a-src', target: `agent-a${String(p).padStart(2, '0')}`, at: T0 - 10_000 + i * 1_000 }))).flat(),
  ...Array.from({ length: PEER_PAIR_LIMIT }, (_, i) =>
    row({ from: 'z-src', target: 'agent-zz', at: T0 - 9_500 + i * 1_000 })),
];
const LIVE_ROWS = (MAX_PAIRS + 1) * PEER_PAIR_LIMIT;

const call = async (args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, value: JSON.parse(text) as PeerLedgerReport & { note: string } };
};

// Evidence is metadata-only: no filesystem paths, stored thread ids, digests
// or internal reader error text may cross the tool boundary, in any state.
const expectNoPrivateDetail = (text: string) => {
  for (const d of [busRoot, dir, file, THREAD, DIGEST, CORRUPT, 'peer-storage-unavailable']) {
    expect(text).not.toContain(d);
  }
};

describe('fleet peer ledger MCP pair lookup (402s)', () => {
  it('finds the exact selected pair that the 64-row display cap hides', async () => {
    writeRows(seedRows());
    const before = readFileSync(file);
    // The unfiltered call stays compatible and honestly truncated: the z pair
    // is absent from the wire entirely, and no selection was requested.
    const wide = await call();
    expect(wide.value).toMatchObject({ v: 1, authority: 'none', status: 'ok',
      asOf: iso(T0), liveRows: LIVE_ROWS, pairLimit: PEER_PAIR_LIMIT, note: NOTE,
      truncated: { pairs: true, origins: false } });
    expect(wide.value.pairs).toHaveLength(MAX_PAIRS);
    expect(wide.value).not.toHaveProperty('selection');
    expect(wide.text).not.toContain('z-src');
    expect(wide.text).not.toContain('agent-zz');
    // The selector filters before the display slice: the hidden pair returns
    // its exact in-window count and computed retryAt, not a slice position.
    const picked = await call({ fromAgent: 'z-src', target: 'agent-zz' });
    expect(picked.value).toMatchObject({ status: 'ok', liveRows: LIVE_ROWS,
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'exact' },
      pairs: [{ fromAgent: 'z-src', target: 'agent-zz', inWindow: PEER_PAIR_LIMIT,
        remaining: 0, lastAt: iso(T0 - 4_500), retryAt: iso(T0 + 50_500) }],
      truncated: { pairs: true }, note: NOTE });
    expectNoPrivateDetail(picked.text);
    // Read-only: private ledger bytes are byte-identical after both calls.
    expect(readFileSync(file)).toEqual(before);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('returns match none for a reversed or absent pair without inventing a budget', async () => {
    writeRows(seedRows());
    for (const pair of [{ fromAgent: 'agent-zz', target: 'z-src' },
        { fromAgent: 'ghost-src', target: 'agent-none' }]) {
      const { text, value } = await call(pair);
      expect(value).toMatchObject({ status: 'ok', liveRows: LIVE_ROWS,
        selection: { ...pair, match: 'none' }, pairs: [], note: NOTE });
      expectNoPrivateDetail(text);
    }
  });

  it('rejects one-sided, extra and malformed selectors without invoking the reader', async () => {
    writeRows(seedRows());
    for (const bad of [{ fromAgent: 'z-src' }, { target: 'agent-zz' },
        { fromAgent: 'z-src', target: 'agent-zz', root: busRoot },
        { fromAgent: 'z-src', target: 'agent-zz', extra: 'x' },
        { fromAgent: 'Z-SRC', target: 'agent-zz' },
        { fromAgent: 'z-src', target: '' }, { fromAgent: 'z-src', target: 7 },
        { pair: { fromAgent: 'z-src', target: 'agent-zz' } }, { root: busRoot }]) {
      const calls = reader.mock.calls.length;
      await expect(client.callTool({ name, arguments: bad })).rejects.toMatchObject({ code: -32602 });
      expect(reader.mock.calls.length).toBe(calls);
    }
    // A valid call immediately after still reaches the same ledger.
    const { value } = await call({ fromAgent: 'z-src', target: 'agent-zz' });
    expect(value).toMatchObject({ status: 'ok', selection: { match: 'exact' } });
  });

  it('reports unavailable over corrupt bytes, then recovers on repair over the same connection', async () => {
    writeRows(seedRows());
    writeFileSync(file, CORRUPT); chmodSync(file, 0o600);
    const corrupt = await call({ fromAgent: 'z-src', target: 'agent-zz' });
    expect(corrupt.value).toMatchObject({ status: 'unavailable', reason: 'peer-ledger-unreadable',
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'none' },
      pairs: [], origins: [], note: NOTE });
    expectNoPrivateDetail(corrupt.text);
    writeRows(seedRows());
    const recovered = await call({ fromAgent: 'z-src', target: 'agent-zz' });
    expect(recovered.value).toMatchObject({ status: 'ok', liveRows: LIVE_ROWS,
      selection: { fromAgent: 'z-src', target: 'agent-zz', match: 'exact' },
      pairs: [{ retryAt: iso(T0 + 50_500) }], note: NOTE });
    expectNoPrivateDetail(recovered.text);
    expect(reader).toHaveBeenCalledTimes(2);
  });
});
