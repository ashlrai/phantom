import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { NOTE, readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const name = 'fleet_peer_ledger';
const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const THREAD = 'fixture-private-thread';
const DIGEST = '3975a1b2'.repeat(8);
const ORIGIN = 'peer-3975a1b2-3975-4975-8975-397539753975';
const iso = (ms: number) => new Date(ms).toISOString();
const REPORT_KEYS = ['asOf', 'authority', 'capacity', 'liveRows', 'maxHops', 'note',
  'origins', 'pairLimit', 'pairs', 'status', 'truncated', 'v', 'windowMs'];

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
  busRoot = realpathSync(mkdtempSync(join(tmpdir(), 'peer-ledger-397s-')));
  dir = join(busRoot, 'agentnet');
  file = join(dir, 'coordination.json');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    peerLedger: () => readFleetPeerLedger({ read: reader }) });
  await server.connect(st);
  client = new Client({ name: 'peer-ledger-397s', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  if (busRoot) rmSync(busRoot, { recursive: true, force: true });
});

const row = (target: string, at: number) => ({
  id: `peer-3975a1b2-3975-4975-8975-${String(++seq).padStart(12, '0')}`,
  fromAgent: 'fixture-src', target, origin: ORIGIN, digest: DIGEST,
  hopCount: 1, threadId: THREAD, at,
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
  for (const detail of [busRoot, dir, file, THREAD, DIGEST, 'peer-storage-unavailable']) {
    expect(text).not.toContain(detail);
  }
};

describe('fleet peer ledger MCP disk recovery (397s)', () => {
  it('round-trips real private evidence through offline failure and recovery', async () => {
    // Absent evidence reads as an honest empty report stamped by the tool clock.
    const absent = await call();
    expect(absent.value).toMatchObject({ v: 1, authority: 'none', status: 'empty', liveRows: 0,
      pairs: [], origins: [], asOf: iso(T0), note: NOTE,
      truncated: { pairs: false, origins: false } });
    expect(reader).toHaveBeenCalledTimes(1);

    // Valid private rows reach the wire unchanged through the real reader.
    writeRows([row('agent1', T0 - 5_000)]);
    nowMs = T0 + 30_000;
    const ok = await call();
    expect(ok.value).toMatchObject({ authority: 'none', status: 'ok', liveRows: 1,
      asOf: iso(nowMs), note: NOTE,
      pairs: [{ fromAgent: 'fixture-src', target: 'agent1', inWindow: 1,
        remaining: PEER_PAIR_LIMIT - 1, lastAt: iso(T0 - 5_000), retryAt: null }],
      origins: [{ origin: ORIGIN, maxHop: 1, nearCap: false }] });
    expect(Object.keys(ok.value).sort()).toEqual(REPORT_KEYS);
    expectNoPrivateDetail(ok.text);

    // Malformed bytes fail closed: no retained pairs, no private detail, fresh asOf.
    writeFileSync(file, 'fixture-private-malformed');
    chmodSync(file, 0o600);
    nowMs = T0 + 40_000;
    const malformed = await call();
    expect(malformed.value).toMatchObject({ authority: 'none', status: 'unavailable',
      reason: 'peer-ledger-unreadable', liveRows: 0, pairs: [], origins: [],
      asOf: iso(nowMs), note: NOTE });
    expect(malformed.text).not.toContain('agent1');
    expect(malformed.text).not.toContain('fixture-private-malformed');
    expectNoPrivateDetail(malformed.text);

    // Repaired rows replace the earlier pair entirely: fresh identities, a
    // saturated pair, and retryAt/asOf read at this call — nothing retained.
    const retryAtMs = T0 + 51_000;
    const ats = Array.from({ length: PEER_PAIR_LIMIT }, (_, i) => retryAtMs - PEER_WINDOW_MS + i * 1_000);
    writeRows(ats.map(at => row('agent2', at)));
    nowMs = T0 + 50_000;
    const recovered = await call();
    expect(recovered.value).toMatchObject({ authority: 'none', status: 'ok',
      liveRows: PEER_PAIR_LIMIT, asOf: iso(nowMs), note: NOTE,
      pairs: [{ fromAgent: 'fixture-src', target: 'agent2', inWindow: PEER_PAIR_LIMIT,
        remaining: 0, lastAt: iso(ats[PEER_PAIR_LIMIT - 1]!), retryAt: iso(retryAtMs) }],
      origins: [{ origin: ORIGIN, maxHop: 1, nearCap: false }] });
    expect(recovered.text).not.toContain('agent1');
    expectNoPrivateDetail(recovered.text);

    // The boundary is exact: one millisecond early still saturated, at retryAt
    // the oldest row leaves the window and the pair frees without sleeping.
    nowMs = retryAtMs - 1;
    const early = await call();
    expect(early.value.pairs[0]).toMatchObject({ target: 'agent2', inWindow: PEER_PAIR_LIMIT,
      remaining: 0, retryAt: iso(retryAtMs) });
    nowMs = retryAtMs;
    const freed = await call();
    expect(freed.value).toMatchObject({ status: 'ok', asOf: iso(retryAtMs),
      pairs: [{ target: 'agent2', inWindow: PEER_PAIR_LIMIT - 1, remaining: 1, retryAt: null }] });

    // A private-mode violation fails closed the same way, then chmod repair
    // serves the fresh evidence again on the very next read.
    chmodSync(file, 0o644);
    const insecure = await call();
    expect(insecure.value).toMatchObject({ authority: 'none', status: 'unavailable',
      reason: 'peer-ledger-unreadable', liveRows: 0, pairs: [], origins: [],
      asOf: iso(nowMs), note: NOTE });
    expect(insecure.text).not.toContain('agent2');
    expectNoPrivateDetail(insecure.text);
    chmodSync(file, 0o600);
    const repaired = await call();
    expect(repaired.value).toMatchObject({ authority: 'none', status: 'ok',
      liveRows: PEER_PAIR_LIMIT, asOf: iso(nowMs), note: NOTE,
      pairs: [{ target: 'agent2', inWindow: PEER_PAIR_LIMIT - 1, remaining: 1, retryAt: null }] });
    expectNoPrivateDetail(repaired.text);
  });

  it('rejects a caller-supplied root without invoking the reader', async () => {
    for (const args of [{ root: busRoot }, { busRoot: '/tmp/elsewhere' }, { root: '/tmp' }]) {
      const calls = reader.mock.calls.length;
      await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({ code: -32602 });
      expect(reader.mock.calls.length).toBe(calls);
    }
  });
});
