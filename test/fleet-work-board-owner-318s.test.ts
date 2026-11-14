/** RQ-PHX-BOARDNAMEDOWNER318S — the work board must surface the durable named
 * owner and claim receipt that collectBusWorkItemEvidence already binds to a
 * receipt, in both JSON and text output. Exercises listWorkBoard and
 * cmdFleetWorkBoard against real durable stores in a private tmp root.
 * Fixtures are plainly fake; labels grant no authority and no fencing token
 * may appear in any output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';

let root: string, now: number;
const TTL = 10_000_000;
const REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000101';
const REF_B = 'T0FAKEWS/C0FAKECH/1700000000.000102';
const iso = (ms: number) => new Date(ms).toISOString();
const request = (id: string, ref?: string, ttl = TTL): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl,
  ...(ref === undefined ? {} : {
    channel: 'slack', channel_ref: ref,
    sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
    external: false,
  }),
  body: { kind: 'work' },
});
const post = (envelope: BusEnvelope) => {
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
};
const acquire = (id: string, owner: string, leaseMs = 600_000) =>
  mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-board-owner-318s-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('listWorkBoard owner and claim receipt', { timeout: 60_000 }, () => {
  it('a claimed request carries the named owner and receipt-bound claim id', () => {
    const postedAt = now;
    post(request('owner-request-a', REF_A));
    now += 1_000;
    post(request('owner-request-b', REF_B));
    const claim = acquire('owner-request-a', 'fake-worker-name');
    expect(claim.status).toBe('acquired');

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    const claimed = board.items.find(i => i.id === 'owner-request-a')!;
    const unclaimed = board.items.find(i => i.id === 'owner-request-b')!;
    expect(claimed.owner).toBe('fake-worker-name');
    expect(claimed.claimReceipt).toBe(`bus-claim:owner-request-a:1:${postedAt}`);
    expect(claimed.state).toBe('RUNNING');
    expect(unclaimed.owner).toBeNull();
    expect(unclaimed.claimReceipt).toBeNull();
    expect(unclaimed.state).toBe('RECEIVED');
    expect(unclaimed.missing).toEqual(['named owner', 'durable claim receipt']);
    // The receipt names coordinates only: no fencing token anywhere.
    expect(JSON.stringify(board)).not.toContain(claim.token!);
    expect(JSON.stringify(board)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('a stale claim for a reposted id cannot supply the owner', () => {
    // First receipt lives only briefly; its claim binds cursor+receivedAt.
    post(request('reposted-id', undefined, 2_000));
    const stale = acquire('reposted-id', 'fake-stale-worker');
    expect(stale.status).toBe('acquired');
    // Let the receipt expire, then a later append reclaims it so the same id
    // posts fresh with a new cursor and receivedAt.
    now += 3_000;
    post(request('pruner-id'));
    post(request('reposted-id'));

    const board = listWorkBoard({ root, now });
    const item = board.items.filter(i => i.id === 'reposted-id');
    expect(item).toHaveLength(1);
    expect(item[0]!.receivedAt).toBe(iso(now));
    expect(item[0]!.owner).toBeNull();
    expect(item[0]!.claimReceipt).toBeNull();
    expect(item[0]!.missing).toEqual(['named owner', 'durable claim receipt']);
    expect(JSON.stringify(board)).not.toContain(stale.token!);
  });
});

describe('cmdFleetWorkBoard owner output', { timeout: 60_000 }, () => {
  it('text lines name owner and claim explicitly; unknown stays explicit', async () => {
    const postedAt = now;
    post(request('owner-request-a', REF_A));
    now += 1_000;
    post(request('owner-request-b', REF_B));
    const claim = acquire('owner-request-a', 'fake-worker-name');
    expect(claim.status).toBe('acquired');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await cmdFleetWorkBoard(['--root', root])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    const claimedLine = lines.find(l => l.startsWith('owner-request-a '))!;
    const unclaimedLine = lines.find(l => l.startsWith('owner-request-b '))!;
    expect(claimedLine).toContain('owner-missing=no');
    expect(claimedLine).toContain('owner=fake-worker-name');
    expect(claimedLine).toContain(`claim=bus-claim:owner-request-a:1:${postedAt}`);
    expect(claimedLine).toContain(`channel=slack ref=${REF_A}`);
    expect(unclaimedLine).toContain('owner-missing=yes');
    expect(unclaimedLine).toContain('owner=unknown claim=unknown');
    expect(unclaimedLine).toContain(`channel=slack ref=${REF_B}`);
    expect(lines.at(-1)).toMatch(/^items=2 truncated=no inbox=ok as-of=/);
    for (const line of lines) expect(line).not.toMatch(/[a-f0-9]{64}/);

    expect(await cmdFleetWorkBoard(['--root', root, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    const byId = new Map(parsed.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.get('owner-request-a')).toMatchObject({
      owner: 'fake-worker-name', claimReceipt: `bus-claim:owner-request-a:1:${postedAt}` });
    expect(byId.get('owner-request-b')).toMatchObject({ owner: null, claimReceipt: null });
    expect(String(log.mock.calls.at(-1)![0])).not.toContain(claim.token!);
  });

  it('the thread filter still narrows items and keeps owner fields honest', async () => {
    post(request('owner-request-a', REF_A));
    now += 1_000;
    post(request('owner-request-b', REF_B));
    expect(acquire('owner-request-b', 'fake-other-worker').status).toBe('acquired');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await cmdFleetWorkBoard(['--root', root, '--thread', REF_A])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('owner-request-a');
    expect(lines[0]).toContain('owner=unknown claim=unknown');
    expect(lines[1]).toMatch(/^items=1 truncated=no inbox=ok as-of=/);

    const filtered = listWorkBoard({ root, now, channelRef: REF_B });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      id: 'owner-request-b', owner: 'fake-other-worker' });
    expect(filtered.items[0]!.claimReceipt).toMatch(/^bus-claim:owner-request-b:\d+:\d+$/);
  });

  it('an unavailable or empty inbox stays honest with null owners', async () => {
    const gone = join(root, 'does-not-exist');
    const board = listWorkBoard({ root: gone, now });
    expect(() => listWorkBoard({ root: gone, now })).not.toThrow();
    expect(board.items).toEqual([]);
    expect(['ok', 'unavailable']).toContain(board.inbox);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', gone, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed.items).toEqual([]);
    expect(['ok', 'unavailable']).toContain(parsed.inbox);
    expect(await cmdFleetWorkBoard(['--root', gone])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/^items=0 truncated=no inbox=(ok|unavailable) as-of=/);
  });
});
