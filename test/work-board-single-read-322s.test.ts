/** RQ-PHX-BOARDSINGLEREAD322S: one board request performs one bounded inbox
 * scan plus one claims inspection, and every listed item is derived from that
 * same settled read — never a per-item rescan that could mix ownership
 * snapshots during fleet churn. Module spies make the read counts
 * deterministic; all stores are real, temporary and private, with fake
 * owners and metadata only. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const real = vi.hoisted(() => ({
  listBusInboxAfter: undefined as unknown as typeof import('../src/core/fleet/bus-inbox.js').listBusInboxAfter,
  inspectBusWorkClaims: undefined as unknown as typeof import('../src/core/fleet/bus-work-claims.js').inspectBusWorkClaims,
}));

vi.mock('../src/core/fleet/bus-inbox.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/fleet/bus-inbox.js')>();
  real.listBusInboxAfter = mod.listBusInboxAfter;
  return { ...mod, listBusInboxAfter: vi.fn(mod.listBusInboxAfter) };
});
vi.mock('../src/core/fleet/bus-work-claims.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/fleet/bus-work-claims.js')>();
  real.inspectBusWorkClaims = mod.inspectBusWorkClaims;
  return { ...mod, inspectBusWorkClaims: vi.fn(mod.inspectBusWorkClaims) };
});

import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim, inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

let root: string, now: number;
const TTL = 10_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const request = (id: string) => {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const reply = (to: string, rid: string, body: unknown) => {
  now += 1_000;
  expect(postBusReply(to, rid, body, { root, now: () => now }).outcome).toBe('posted');
};
const acquire = (id: string, owner: string, leaseMs = 600_000) => {
  now += 1_000;
  return mutateBusWorkClaim({ action: 'acquire', id, owner, leaseMs, root });
};
const complete = (id: string, token: string) => {
  now += 1_000;
  return mutateBusWorkClaim({ action: 'complete', id, token, root });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-board-single-read-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(listBusInboxAfter).mockReset().mockImplementation(real.listBusInboxAfter);
  vi.mocked(inspectBusWorkClaims).mockReset().mockImplementation(real.inspectBusWorkClaims);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('listWorkBoard single-read agreement', { timeout: 60_000 }, () => {
  it('board items agree with the single-item collector for every state', () => {
    request('fake-received');
    request('fake-running');
    acquire('fake-running', 'fake-owner-run');
    request('fake-blocked');
    reply('fake-blocked', 'fake-reply-blocked', { blocked: { dependency: 'fake-dependency-review' } });
    request('fake-verified');
    reply('fake-verified', 'fake-reply-verified', { verified: { pr: 7, head: 'fakehead1' } });
    request('fake-assigned');
    const done = acquire('fake-assigned', 'fake-owner-done');
    expect(done.status).toBe('acquired');
    expect(complete('fake-assigned', done.token!).status).toBe('completed');

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    const states = new Map(board.items.map(item => [item.id, item.state]));
    expect(states.get('fake-received')).toBe('RECEIVED');
    expect(states.get('fake-running')).toBe('RUNNING');
    expect(states.get('fake-blocked')).toBe('BLOCKED');
    expect(states.get('fake-verified')).toBe('VERIFIED');
    expect(states.get('fake-assigned')).toBe('ASSIGNED');
    // Replies are evidence, never board rows.
    expect(board.items.map(item => item.id)).not.toContain('fake-reply-blocked');
    expect(board.items.map(item => item.id)).not.toContain('fake-reply-verified');

    for (const item of board.items) {
      const { evidence, sources } = collectBusWorkItemEvidence(item.id, { root, now });
      expect(sources.inbox).toBe('found');
      const classified = classifyWorkItem(evidence, iso(now));
      expect(classified.state).toBe(item.state);
      expect(classified.asOf).toBe(item.asOf);
      expect(classified.source).toBe(item.source);
      expect(classified.missing).toEqual(item.missing);
      expect(evidence.owner ?? null).toBe(item.owner);
      expect(evidence.claimReceipt ?? null).toBe(item.claimReceipt);
    }
    const running = board.items.find(item => item.id === 'fake-running')!;
    expect(running.owner).toBe('fake-owner-run');
    expect(running.claimReceipt).toMatch(/^bus-claim:fake-running:\d+:\d+$/);
    expect(JSON.stringify(board)).not.toMatch(/[a-f0-9]{64}/);
  });
});

describe('listWorkBoard read counts', { timeout: 60_000 }, () => {
  it('inbox pages and claims inspections do not scale with returned items', () => {
    for (const id of ['fake-a', 'fake-b', 'fake-c', 'fake-d', 'fake-e', 'fake-f']) request(id);
    reply('fake-a', 'fake-reply-a', { text: 'fake ack' });
    acquire('fake-b', 'fake-owner-b');

    // A small store settles in exactly two page reads (one full page, then the
    // empty settling page); the board must pay that once, not once per item.
    vi.mocked(listBusInboxAfter).mockClear();
    vi.mocked(inspectBusWorkClaims).mockClear();
    const one = listWorkBoard({ root, now, limit: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.truncated).toBe(true);
    expect(vi.mocked(listBusInboxAfter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(inspectBusWorkClaims)).toHaveBeenCalledTimes(1);

    vi.mocked(listBusInboxAfter).mockClear();
    vi.mocked(inspectBusWorkClaims).mockClear();
    const all = listWorkBoard({ root, now, limit: 100 });
    expect(all.items.length).toBeGreaterThan(one.items.length);
    expect(vi.mocked(listBusInboxAfter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(inspectBusWorkClaims)).toHaveBeenCalledTimes(1);
    // Nothing is cached across requests: a second board read scans again.
    vi.mocked(listBusInboxAfter).mockClear();
    vi.mocked(inspectBusWorkClaims).mockClear();
    listWorkBoard({ root, now });
    expect(vi.mocked(listBusInboxAfter)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(inspectBusWorkClaims)).toHaveBeenCalledTimes(1);
  });
});

describe('listWorkBoard consistency under churn', { timeout: 60_000 }, () => {
  it('a claims table that changes between reads cannot mix owners in one board', () => {
    request('fake-item-a');
    acquire('fake-item-a', 'fake-owner-one');
    request('fake-item-b');
    acquire('fake-item-b', 'fake-owner-two');

    const snapshot = real.inspectBusWorkClaims(root);
    expect(snapshot.source).toBe('available');
    const swapped = snapshot.claims.map(claim => ({
      ...claim,
      owner: claim.id === 'fake-item-a' ? 'fake-owner-two' : 'fake-owner-one',
    }));
    // First inspection sees the real table; any later per-item re-read would
    // see swapped owners — exactly the mixed snapshot the board must avoid.
    vi.mocked(inspectBusWorkClaims)
      .mockReturnValueOnce({ source: 'available', claims: snapshot.claims })
      .mockReturnValue({ source: 'available', claims: swapped });
    vi.mocked(inspectBusWorkClaims).mockClear();

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    const byId = new Map(board.items.map(item => [item.id, item]));
    expect(byId.get('fake-item-a')!.owner).toBe('fake-owner-one');
    expect(byId.get('fake-item-b')!.owner).toBe('fake-owner-two');
    expect(vi.mocked(inspectBusWorkClaims)).toHaveBeenCalledTimes(1);
  });

  it('an unsettled or churning scan reports unavailable, never a partial verified read', () => {
    request('fake-partial');
    reply('fake-partial', 'fake-reply-verified', { verified: { pr: 3, head: 'fakehead2' } });

    // Page one succeeds (it already contains the verified reply); page two
    // churns. The whole read must fail rather than classify on page one.
    vi.mocked(listBusInboxAfter)
      .mockImplementation(() => ({ status: 'retryable' }) as ReturnType<typeof listBusInboxAfter>)
      .mockImplementationOnce((after, limit, options) => real.listBusInboxAfter(after, limit, options));

    const board = listWorkBoard({ root, now });
    expect(board).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: 'missing' });

    const { evidence, sources } = collectBusWorkItemEvidence('fake-partial', { root, now });
    expect(sources.inbox).toBe('unavailable');
    expect(evidence).toEqual({ id: 'fake-partial' });
    expect(classifyWorkItem(evidence, iso(now)).state).toBe('RECEIVED');
  });

  it('a corrupt inbox snapshot reports unavailable on board and collector', () => {
    request('fake-corrupt');
    const file = join(root, 'bus-inbox', 'messages.json');
    writeFileSync(file, '{not json', { mode: 0o600 });
    chmodSync(file, 0o600);

    const board = listWorkBoard({ root, now });
    expect(board).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: 'missing' });
    const { evidence, sources } = collectBusWorkItemEvidence('fake-corrupt', { root, now });
    expect(sources.inbox).toBe('unavailable');
    expect(evidence).toEqual({ id: 'fake-corrupt' });
  });
});
