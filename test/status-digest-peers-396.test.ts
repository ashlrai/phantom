import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPeerLedger } from '../src/core/agentnet/peer-ledger.js';
import { buildStatusDigest, type StatusDigestInput, type StatusDigestPeers } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, summarizePeerLedger } from '../src/core/leader/status-digest-sources.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const NOW = 1_800_000_000_000;
let root: string, n = 0;
const row = (from: string, target: string, at: number, over: Record<string, unknown> = {}) => ({
  id: `peer-${UUID.slice(0, 35)}${n++ % 10}`, fromAgent: from, target, origin: `peer-${UUID}`, digest: 'a'.repeat(64),
  hopCount: 1, threadId: 'thread-id', at, ...over });
const write = (rows: unknown[]) => {
  mkdirSync(join(root, 'agentnet'), { recursive: true });
  writeFileSync(join(root, 'agentnet', 'coordination.json'), JSON.stringify(rows), { mode: 0o600 });
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'digest-peers-')); n = 0; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stubs = {
  installedVersion: () => '1.0.0',
  publishedVersion: async () => '1.0.0',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => ({ lanes: [], sources: { status: 'healthy' }, runsDirPresent: true }),
  needs: () => ({ status: 'missing', items: [] }),
  inbox: async () => ({ sourceState: 'ok', entries: [] }),
  workClaims: undefined,
} as never;
const ok = <T>(value: T) => ({ ok: true as const, value });
const base = (peers?: StatusDigestPeers | null): StatusDigestInput => ({
  installedVersion: ok('1.0.0'), publishedVersion: ok('1.0.0'), updatePending: false,
  mergesLastHour: ok(1), mergesLast24h: ok(2), lanes: ok([]), needsMason: ok(0), topP0: ok(null),
  ...(peers === undefined ? {} : { peers }),
});
const peers = (over: Partial<StatusDigestPeers>): StatusDigestPeers => ({ status: 'ok', rateLimited: 0, tightest: null, nearCap: 0, ...over });

describe('buildStatusDigest Peers line', () => {
  it('stays silent for undefined, null, empty and ok-with-headroom', () => {
    for (const p of [undefined, null, peers({ status: 'empty' }), peers({})]) {
      expect(buildStatusDigest(base(p))).toHaveLength(5);
    }
  });
  it('renders rate-limited and near-cap', () => {
    const lines = buildStatusDigest(base(peers({ rateLimited: 2, tightest: 'agent0 → agent1', nearCap: 1 })));
    expect(lines[5]).toBe('Peers: 2 pairs rate-limited (agent0 → agent1) · 1 conversation near hop cap');
  });
  it('renders near-cap alone and a singular pair', () => {
    expect(buildStatusDigest(base(peers({ nearCap: 3 })))[5]).toBe('Peers: 3 conversations near hop cap');
    expect(buildStatusDigest(base(peers({ rateLimited: 1, tightest: 'agent0 → agent1' })))[5]).toBe('Peers: 1 pair rate-limited (agent0 → agent1)');
  });
  it('renders unknown with its reason', () => {
    expect(buildStatusDigest(base(peers({ status: 'unavailable', reason: 'peer-ledger-unreadable' })))[5]).toBe('Peers: unknown (peer-ledger-unreadable)');
  });
  it('keeps the existing line order and appends Peers last', () => {
    const lines = buildStatusDigest({ ...base(peers({ nearCap: 1 })), workClaims: ok(null) });
    expect(lines.map(l => l.split(':')[0])).toEqual(['App', 'Merges', 'Lanes', 'Needs the owner', 'Top P0', 'Claims', 'Peers']);
  });
});

describe('peers source', () => {
  it('maps 6 in-window rows agent0→agent1 to one rate-limited pair', () => {
    write(Array.from({ length: 6 }, () => row('agent0', 'agent1', NOW - 1000)));
    expect(summarizePeerLedger(readPeerLedger({ busRoot: root, now: () => NOW })))
      .toEqual({ status: 'ok', rateLimited: 1, tightest: 'agent0 → agent1', nearCap: 0 });
  });
  it('flows through gatherStatusDigestInput with an injected reader', async () => {
    write(Array.from({ length: 6 }, () => row('agent0', 'agent1', NOW - 1000, { hopCount: 7 })));
    const input = await gatherStatusDigestInput(root, new Date(NOW), { ...stubs as object, peers: now => readPeerLedger({ busRoot: root, now: () => now }) });
    expect(input.peers).toEqual({ status: 'ok', rateLimited: 1, tightest: 'agent0 → agent1', nearCap: 1 });
  });
  it('maps a throwing reader to the unknown shape', async () => {
    const input = await gatherStatusDigestInput(root, new Date(NOW), { ...stubs as object, peers: () => { throw new Error('boom'); } });
    expect(input.peers).toEqual({ status: 'unavailable', reason: 'peer ledger reader failed', rateLimited: 0, tightest: null, nearCap: 0 });
  });
});
