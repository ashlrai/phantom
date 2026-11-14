import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string, now: number;
const id = 'fake-request';
const post = (name = id, ttl = 10_000_000) => expect(appendBusInbox({ id: name, from: 'fake-host',
  to: 'fake-lane', priority: 'P1', ttl, body: { kind: 'work', text: 'private-body-marker' } },
{ root, now: () => now }).status).toBe('posted');
const snapshot = () => ['bus-inbox/messages.json', 'bus-work-claims/claims.json'].map(p => {
  try { return readFileSync(join(root, p), 'utf8'); } catch { return null; }
});
const run = async (json = true) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetWorkTrace(['--id', id, '--root', root, ...(json ? ['--json'] : [])])).toBe(0);
  const output = String(log.mock.calls.at(-1)![0]);
  log.mockRestore();
  return output;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-owner-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports receipt-bound ownership in both formats without changing stores or exposing private data', async () => {
  post();
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 600_000, root });
  expect(claim.status).toBe('acquired');
  const before = snapshot();
  const json = await run();
  const text = await run(false);
  const receipt = `bus-claim:${id}:1:${now}`;
  expect(JSON.parse(json)).toMatchObject({ owner: 'fake-worker', claimReceipt: receipt, state: 'RUNNING',
    asOf: new Date(now).toISOString(), source: `bus-work-claims lease-until ${new Date(now + 600_000).toISOString()}`,
    inbox: 'found', claims: 'available' });
  expect(text).toContain(`owner=fake-worker claimReceipt=${receipt}`);
  expect(text).toContain(`as-of=${new Date(now).toISOString()} source=bus-work-claims`);
  expect(text).toContain('inbox=found claims=available');
  for (const output of [json, text]) {
    expect(output).not.toContain(claim.token!);
    expect(output).not.toContain('private-body-marker');
  }
  expect(snapshot()).toEqual(before);
});

it('does not bind a stale claim to a reposted receipt', async () => {
  post(id, 2_000);
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 600_000, root });
  now += 3_000;
  post('fake-pruner');
  post();
  const before = snapshot();
  const output = await run();
  expect(JSON.parse(output)).toMatchObject({ owner: null, claimReceipt: null, state: 'RECEIVED',
    asOf: new Date(now).toISOString(), inbox: 'found', claims: 'available' });
  expect(output).not.toContain(claim.token!);
  expect(snapshot()).toEqual(before);
});

it('reports null ownership for missing and unreadable claim stores', async () => {
  post();
  expect(JSON.parse(await run())).toMatchObject({ owner: null, claimReceipt: null, claims: 'missing' });
  mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 600_000, root });
  writeFileSync(join(root, 'bus-work-claims/claims.json'), 'invalid');
  const before = snapshot();
  expect(JSON.parse(await run())).toMatchObject({ owner: null, claimReceipt: null, claims: 'unavailable' });
  expect(snapshot()).toEqual(before);
});

it('rejects whitespace-only id before touching stores', async () => {
  post();
  const before = snapshot();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetWorkTrace(['--id', ' \t ', '--root', root, '--json'])).toBe(2);
  expect(log).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
});
