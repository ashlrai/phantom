import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';
import { PEER_WINDOW_MS } from '../src/core/agentnet/peer-bus.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_800_000_000_000, HOUR = 3_600_000;
let root: string, n = 0;
const row = (from: string, target: string, at: number, over: Record<string, unknown> = {}) => ({
  id: `peer-${UUID.slice(0, 35)}${(n++ % 10).toString(16)}`, fromAgent: from, target, origin: `peer-${UUID}`, digest: 'b'.repeat(64),
  hopCount: 1, threadId: 'thread-secret-id', at, ...over });
function write(rows: unknown[], mode = 0o600) {
  mkdirSync(join(root, 'agentnet'), { recursive: true });
  writeFileSync(join(root, 'agentnet', 'coordination.json'), JSON.stringify(rows), { mode });
}
const read = () => readPeerLedger({ busRoot: root, now: () => NOW });
const iso = (ms: number) => new Date(ms).toISOString();
const pair = (r: ReturnType<typeof read>, from: string, target: string) =>
  r.pairs.find(p => p.fromAgent === from && p.target === target);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'peer-ledger-retry-')); n = 0; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('peer ledger retryAt evidence', () => {
  it('reports the oldest-row expiry for exactly six staggered rows', () => {
    const ats = [NOW - 50_000, NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000, NOW - 1_000];
    write(ats.map(at => row('agent0', 'agent1', at)));
    const p = pair(read(), 'agent0', 'agent1');
    expect(p).toMatchObject({ inWindow: 6, remaining: 0, retryAt: iso(NOW - 50_000 + PEER_WINDOW_MS) });
  });
  it('uses the (n-limit+1)-th expiry when more than six rows are retained', () => {
    const ats = [NOW - 55_000, NOW - 50_000, NOW - 45_000, NOW - 40_000, NOW - 30_000, NOW - 20_000, NOW - 10_000, NOW - 5_000];
    write(ats.map(at => row('agent0', 'agent1', at)));
    const p = pair(read(), 'agent0', 'agent1');
    expect(p).toMatchObject({ inWindow: 8, remaining: 0, retryAt: iso(NOW - 45_000 + PEER_WINDOW_MS) });
  });
  it('treats a row at exact window expiry as no longer debiting', () => {
    write([row('agent0', 'agent1', NOW - PEER_WINDOW_MS),
      ...Array.from({ length: 5 }, () => row('agent0', 'agent1', NOW - 1_000))]);
    const p = pair(read(), 'agent0', 'agent1');
    expect(p).toMatchObject({ inWindow: 5, remaining: 1, retryAt: null });
  });
  it('is null for an unblocked pair', () => {
    write([row('agent0', 'agent1', NOW - 1_000), row('agent0', 'agent1', NOW - 30_000)]);
    const p = pair(read(), 'agent0', 'agent1');
    expect(p).toMatchObject({ inWindow: 2, remaining: 4, retryAt: null });
  });
  it('keeps directed pairs independent', () => {
    write([...Array.from({ length: 6 }, (_, i) => row('agent0', 'agent1', NOW - (6 - i) * 1_000)),
      row('agent1', 'agent0', NOW - 1_000), row('agent0', 'agent2', NOW - 2_000)]);
    const r = read();
    expect(pair(r, 'agent0', 'agent1')).toMatchObject({ inWindow: 6, remaining: 0 });
    expect(pair(r, 'agent0', 'agent1')!.retryAt).not.toBeNull();
    expect(pair(r, 'agent1', 'agent0')).toMatchObject({ inWindow: 1, remaining: 5, retryAt: null });
    expect(pair(r, 'agent0', 'agent2')).toMatchObject({ inWindow: 1, remaining: 5, retryAt: null });
  });
  it('ignores rows retained past the 24h live horizon', () => {
    write([...Array.from({ length: 6 }, () => row('agent0', 'agent1', NOW - 25 * HOUR)),
      row('agent0', 'agent1', NOW - 1_000)]);
    const r = read();
    expect(r.liveRows).toBe(1);
    expect(pair(r, 'agent0', 'agent1')).toMatchObject({ inWindow: 1, remaining: 5, retryAt: null });
  });
  it('stays unavailable on future-row clock evidence', () => {
    write([row('agent0', 'agent1', NOW - 1_000), row('agent0', 'agent2', NOW + 5)]);
    expect(read()).toMatchObject({ status: 'unavailable', reason: 'peer-clock-reversed', pairs: [] });
  });
  it('writes nothing and discloses no payload, thread or digest', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row('agent0', 'agent1', NOW - (6 - i) * 1_000));
    write(rows);
    const file = join(root, 'agentnet', 'coordination.json');
    const before = { listing: readdirSync(join(root, 'agentnet')).sort(), bytes: readFileSync(file) };
    const r = read();
    expect(readdirSync(join(root, 'agentnet')).sort()).toEqual(before.listing);
    expect(readFileSync(file)).toEqual(before.bytes);
    const text = JSON.stringify(r);
    expect(text).not.toContain('b'.repeat(64));
    expect(text).not.toContain('thread-secret-id');
    expect(text).not.toContain('digest');
    expect(text).not.toContain('threadId');
    expect(r.authority).toBe('none');
  });
});
