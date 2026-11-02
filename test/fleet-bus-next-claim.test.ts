import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, BUS_INBOX_MAX_READ } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { claimNextBusWork } from '../src/core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string, now: number;
const request = () => ({ to: 'worker-a', owner: 'worker-a', leaseMs: 60_000, root });
function post(id: string, changes: Partial<BusEnvelope> = {}) {
  const envelope: BusEnvelope = { id, from: 'fake-sender', to: 'worker-a', priority: 'P2', ttl: 120_000, body: { kind: 'work', text: 'fake work' }, ...changes };
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
}
function acquired() {
  const result = claimNextBusWork(request());
  expect(result.status).toBe('acquired');
  if (result.status !== 'acquired' || !('token' in result)) throw new Error('expected a claim');
  return result;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-next-')); now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('orders priority then cursor, fences live leases, and honors completion and release', () => {
  post('low', { priority: 'P3' }); post('first-high', { priority: 'P0' }); post('second-high', { priority: 'P0' });
  post('chat', { priority: 'P0', body: 'fake chat' }); post('other', { priority: 'P0', to: 'worker-b' });
  const first = acquired();
  expect(first.receipt.envelope.id).toBe('first-high');
  expect(first.leaseUntil).toBe(now + 60_000);
  const second = acquired();
  expect(second.receipt.envelope.id).toBe('second-high');
  expect(mutateBusWorkClaim({ action: 'complete', id: 'first-high', token: first.token, root }).status).toBe('completed');
  expect(mutateBusWorkClaim({ action: 'release', id: 'second-high', token: second.token, root }).status).toBe('released');
  const again = acquired();
  expect(again.receipt.envelope.id).toBe('second-high');
  expect(again.token).not.toBe(second.token);
  expect(acquired().receipt.envelope.id).toBe('low');
  expect(claimNextBusWork({ ...request(), owner: 'worker-b' })).toEqual({ status: 'empty' });
});

it('passes the first page, follows sparse high-water cursors and ignores expired work', () => {
  post('expired', { ttl: 1, priority: 'P0' });
  now += 2;
  post('chat-0', { body: { kind: 'chat' } });
  const path = join(root, 'bus-inbox', 'messages.json');
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  const seed = snapshot.rows[0];
  // Construct retained sparse history, then append the matching receipt normally.
  snapshot.rows = Array.from({ length: BUS_INBOX_MAX_READ }, (_, i) => ({
    ...seed, cursor: 10_001 + i, envelope: { ...seed.envelope, id: `chat-${i}` },
  }));
  snapshot.highWater = 10_000 + BUS_INBOX_MAX_READ;
  writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
  post('beyond', { priority: 'P1' });
  const result = acquired();
  expect(result.receipt.envelope.id).toBe('beyond');
  expect(result.receipt.cursor).toBeGreaterThan(10_000 + BUS_INBOX_MAX_READ);
  now += 120_000;
  expect(claimNextBusWork(request())).toEqual({ status: 'empty' });
}, 120_000);

it('reports actual lock contention and claim storage errors without returning a body or token', () => {
  post('work');
  const first = acquired();
  expect(mutateBusWorkClaim({ action: 'release', id: 'work', token: first.token, root }).status).toBe('released');
  const lock = acquireLocalStoreLockWithOutcome(join(root, 'bus-work-claims', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  expect(lock.state).toBe('acquired');
  try { expect(claimNextBusWork(request())).toEqual({ status: 'retryable' }); }
  finally { if (lock.state === 'acquired') releaseLocalStoreLock(lock.lock); }
  writeFileSync(join(root, 'bus-work-claims', 'claims.json'), '{invalid', { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'unavailable' });
});

it('returns empty for missing inbox and unavailable for corrupt inbox', () => {
  expect(claimNextBusWork(request())).toEqual({ status: 'empty' });
  post('work');
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'unavailable' });
});

it('reports full claim storage rather than declaring the queue empty', () => {
  post('first');
  acquired();
  const path = join(root, 'bus-work-claims', 'claims.json');
  const [row] = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(Array.from({ length: 1024 }, (_, i) => ({ ...row, id: `old-${i}` }))), { mode: 0o600 });
  expect(claimNextBusWork(request())).toEqual({ status: 'full' });
});
