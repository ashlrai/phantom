import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { waitClaimBusWork } from '../src/core/fleet/bus-wait-claim.js';
import { cmdFleetBusWaitClaim } from '../src/cli/fleet-bus-wait-claim.js';
import { cmdFleet } from '../src/cli/fleet.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string;
const request = () => ({ to: 'worker-a', owner: 'worker-a', leaseMs: 60000, waitMs: 12000, root });
const args = () => ['--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--wait-ms', '12000', '--root', root, '--json'];
function post(id: string, to = 'worker-a', ttl = 60000, now = Date.now()) {
  expect(appendBusInbox({ id, from: 'sender', to, priority: 'P2', ttl, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-wait-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('waits for publication and fences two competing waiters with a durable claim', async () => {
  const first = waitClaimBusWork(request());
  const second = waitClaimBusWork({ ...request(), owner: 'worker-b' });
  await new Promise(resolve => setTimeout(resolve, 50));
  post('work');
  const results = await Promise.all([first, second]);
  expect(results.map(r => r.status).sort()).toEqual(['acquired', 'timeout']);
  const acquired = results.find(r => r.status === 'acquired');
  if (!acquired || !('token' in acquired)) throw new Error('missing claim');
  expect(acquired.receipt.envelope.id).toBe('work');
  expect(acquired.token).toMatch(/^[a-f0-9]{64}$/);
  expect(acquired.leaseUntil).toBeGreaterThan(Date.now());
  expect(mutateBusWorkClaim({ action: 'complete', id: 'work', token: acquired.token, root }).status).toBe('completed');
  expect((await waitClaimBusWork({ ...request(), waitMs: 20 })).status).toBe('timeout');
});

it('ignores other destinations and expired work, then times out without claims', async () => {
  post('other', 'worker-b'); post('expired', 'worker-a', 1, Date.now() - 1000);
  expect(await waitClaimBusWork({ ...request(), waitMs: 20 })).toEqual({ status: 'timeout' });
  expect(existsSync(join(root, 'bus-work-claims', 'claims.json'))).toBe(false);
});

it('cancels promptly without a claim and reports store errors', async () => {
  const controller = new AbortController();
  const waiting = waitClaimBusWork(request(), controller.signal);
  controller.abort();
  expect(await waiting).toEqual({ status: 'cancelled' });
  expect(existsSync(join(root, 'bus-work-claims', 'claims.json'))).toBe(false);
  post('work');
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
  expect(await waitClaimBusWork(request())).toEqual({ status: 'unavailable' });
});

it('rejects malformed arguments before creating storage', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const bad of [[], [...args(), '--json'], [...args(), '--to', 'duplicate'], [...args(), '--bad'],
    args().slice(0, -1), args().map(x => x === '12000' ? '0' : x), args().map(x => x === '12000' ? '300001' : x),
    args().map(x => x === '12000' ? '1e2' : x), args().map(x => x === '60000' ? '3600001' : x),
    args().map(x => x === root ? 'relative' : x), args().slice(0, -2)]) {
    expect(await cmdFleetBusWaitClaim(bad)).toBe(2);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual({ status: 'invalid' });
  }
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('invokes the command via fleet convention dispatch', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  post('work');
  expect(await cmdFleet(['bus-wait-claim', ...args()])).toBe(0);
  expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'work' } } });
  expect(output).toHaveBeenCalledTimes(1);
});
