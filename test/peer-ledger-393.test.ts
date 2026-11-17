import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPeerLedger } from '../src/cli/fleet-peer-ledger.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_800_000_000_000, HOUR = 3_600_000;
let root: string, n = 0;
const row = (from: string, target: string, at: number, over: Record<string, unknown> = {}) => ({
  id: `peer-${UUID.slice(0, 35)}${n++ % 10}`, fromAgent: from, target, origin: `peer-${UUID}`, digest: 'a'.repeat(64),
  hopCount: 1, threadId: 'thread-secret-id', at, ...over });
function write(rows: unknown[], mode = 0o600) {
  mkdirSync(join(root, 'agentnet'), { recursive: true });
  writeFileSync(join(root, 'agentnet', 'coordination.json'), JSON.stringify(rows), { mode });
}
const read = () => readPeerLedger({ busRoot: root, now: () => NOW });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'peer-ledger-')); n = 0; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('readPeerLedger', () => {
  it('reports empty for a missing file', () => {
    const r = read();
    expect(r).toMatchObject({ status: 'empty', liveRows: 0, capacity: 1024, authority: 'none', pairs: [] });
  });
  it('computes per-pair budgets sorted by remaining', () => {
    write([...Array.from({ length: 2 }, () => row('agent0', 'agent2', NOW - 1000)),
      ...Array.from({ length: 6 }, () => row('agent0', 'agent1', NOW - 1000))]);
    const r = read();
    expect(r.status).toBe('ok');
    expect(r.pairs[0]).toMatchObject({ fromAgent: 'agent0', target: 'agent1', inWindow: 6, remaining: 0 });
    expect(r.pairs[1]).toMatchObject({ target: 'agent2', inWindow: 2, remaining: 4 });
  });
  it('excludes rows older than 24h and rows outside the window from inWindow', () => {
    write([row('agent0', 'agent1', NOW - 25 * HOUR), row('agent0', 'agent1', NOW - HOUR)]);
    const r = read();
    expect(r.liveRows).toBe(1);
    expect(r.pairs[0]).toMatchObject({ inWindow: 0, remaining: 6 });
  });
  it('flags origins near the hop cap', () => {
    write([row('agent0', 'agent1', NOW - 1000, { hopCount: 7 })]);
    expect(read().origins).toEqual([{ origin: `peer-${UUID}`, maxHop: 7, nearCap: true }]);
  });
  it('is unavailable when a row is in the future', () => {
    write([row('agent0', 'agent1', NOW + 5)]);
    expect(read()).toMatchObject({ status: 'unavailable', reason: 'peer-clock-reversed' });
  });
  it('is unavailable on a non-finite clock', () => {
    expect(readPeerLedger({ busRoot: root, now: () => Number.NaN })).toMatchObject({ status: 'unavailable', reason: 'invalid-clock' });
  });
  it('is unavailable for a public file and leaks nothing', () => {
    write([row('agent0', 'agent1', NOW - 1000)], 0o644);
    const r = read(), text = JSON.stringify(r);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'peer-ledger-unreadable' });
    expect(text).not.toContain('aaaaaaaa');
    expect(text).not.toContain('threadId');
    expect(text).not.toContain('peer-storage-unavailable');
  });
});

describe('cmdFleetPeerLedger', () => {
  let out: string;
  beforeEach(() => {
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { out += String(s); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());
  it('prints JSON and exits 0', async () => {
    write([row('agent0', 'agent1', NOW - 1000)]);
    expect(await cmdFleetPeerLedger(['--json'], { read })).toBe(0);
    expect(JSON.parse(out).status).toBe('ok');
  });
  it('prints a human summary', async () => {
    write([row('agent0', 'agent1', NOW - 1000)]);
    expect(await cmdFleetPeerLedger([], { read })).toBe(0);
    expect(out).toContain('agent0 -> agent1  1/6  remaining 5');
  });
  it('rejects unknown arguments with 2', async () => {
    expect(await cmdFleetPeerLedger(['--bogus'])).toBe(2);
  });
  it('exits 1 when the reader throws', async () => {
    const throwing = (): PeerLedgerReport => { throw new Error('boom secret'); };
    expect(await cmdFleetPeerLedger(['--json'], { read: throwing })).toBe(1);
    expect(JSON.parse(out)).toEqual({ status: 'unavailable', reason: 'peer-ledger-unavailable' });
  });
});
