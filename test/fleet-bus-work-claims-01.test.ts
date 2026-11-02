import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdFleetBusClaim } from '../src/cli/fleet-bus-claim.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

let root: string, now: number;
let output: ReturnType<typeof vi.spyOn>;
const state = () => join(root, 'bus-work-claims', 'claims.json');
async function command(action: string, extra: string[] = [], id = 'message') {
  const callIndex = output.mock.calls.length;
  const code = await cmdFleetBusClaim([action, '--id', id, ...extra, '--root', root, '--json']);
  const result = JSON.parse(String(output.mock.calls[callIndex]![0])) as { status: string; token?: string; leaseUntil?: number };
  return { code, ...result };
}
const acquire = (owner = 'worker') => command('acquire', ['--owner', owner, '--lease-ms', '1000']);
const settle = (action: string, token: string) => command(action, ['--token', token]);
function post(id = 'message', ttl = 10_000) {
  expect(appendBusInbox({ id, from: 'fake', to: 'shared', priority: 'P1', ttl, body: 'PRIVATE_BODY' }, { root, now: () => now }).status).toBe('posted');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-claims-'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  post();
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); }, 60_000);

describe('fleet bus work claims through exported CLI and real stores', () => {
  it('allows exactly one independent acquisition, including identical labels', async () => {
    const results = await Promise.all([acquire(), acquire()]);
    expect(results.map(r => r.status)).toEqual(['acquired', 'conflict']);
    expect(results[1]!.code).toBe(1);
    expect(readFileSync(state(), 'utf8')).not.toContain('PRIVATE_BODY');
    expect(statSync(state()).mode & 0o777).toBe(0o600);
  }, 60_000);
  it('requires the token for renewal and settlement and preserves state on refusal', async () => {
    const first = await acquire();
    const before = readFileSync(state(), 'utf8');
    for (const action of ['renew', 'release', 'complete']) {
      expect(await settle(action, 'a'.repeat(64))).toMatchObject({ status: 'mismatched-token', code: 1 });
      expect(readFileSync(state(), 'utf8')).toBe(before);
    }
    now += 500;
    expect(await settle('renew', first.token!)).toMatchObject({ status: 'renewed', code: 0, leaseUntil: now + 1000 });
    expect(await settle('complete', first.token!)).toMatchObject({ status: 'completed', code: 0 });
    expect(await acquire()).toMatchObject({ status: 'completed', code: 1 });
    expect(await settle('complete', first.token!)).toMatchObject({ status: 'completed', code: 1 });
  }, 60_000);
  it('hands expired leases to a fresh token and fences old tokens', async () => {
    const first = await acquire();
    now += 1000;
    expect(await settle('renew', first.token!)).toMatchObject({ status: 'expired', code: 1 });
    const second = await acquire('replacement');
    expect(second.status).toBe('acquired');
    expect(second.token).not.toBe(first.token);
    expect(await settle('release', first.token!)).toMatchObject({ status: 'mismatched-token', code: 1 });
    expect(await settle('release', second.token!)).toMatchObject({ status: 'released', code: 0 });
    expect((await acquire()).status).toBe('acquired');
  }, 60_000);
  it('caps renewals at the original receipt TTL and refuses expired or missing messages', async () => {
    now += 9500;
    const first = await acquire();
    expect(first.leaseUntil).toBe(now + 500);
    now += 250;
    expect((await settle('renew', first.token!)).leaseUntil).toBe(now + 250);
    now += 250;
    expect(await acquire()).toMatchObject({ status: 'expired', code: 1 });
    expect(await settle('complete', first.token!)).toMatchObject({ status: 'expired', code: 1 });
    expect(await command('acquire', ['--owner', 'w', '--lease-ms', '100'], 'absent')).toMatchObject({ status: 'missing', code: 1 });
  }, 60_000);
  it('fails closed on malformed state and rejects arguments before storage', async () => {
    await acquire();
    writeFileSync(state(), '{broken', { mode: 0o600 });
    expect(await acquire()).toMatchObject({ status: 'unavailable', code: 1 });
    expect(readFileSync(state(), 'utf8')).toBe('{broken');
    expect(await command('acquire', ['--owner', 'w', '--lease-ms', '0'])).toMatchObject({ status: 'invalid', code: 2 });
    expect(await command('renew', ['--owner', 'w'])).toMatchObject({ status: 'invalid', code: 2 });
  }, 60_000);
  it('refuses capacity without evicting completion tombstones', async () => {
    const first = await acquire();
    await settle('complete', first.token!);
    const row = JSON.parse(readFileSync(state(), 'utf8'))[0];
    const rows = Array.from({ length: 1024 }, (_, i) => ({ ...row, id: `old-${i}` }));
    writeFileSync(state(), JSON.stringify(rows), { mode: 0o600 });
    const before = readFileSync(state(), 'utf8');
    expect(await acquire()).toMatchObject({ status: 'full', code: 1 });
    expect(readFileSync(state(), 'utf8')).toBe(before);
  }, 60_000);
  it('reports lock contention without changing state', async () => {
    const first = await acquire();
    const lock = acquireLocalStoreLockWithOutcome(join(root, 'bus-work-claims', 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired');
    try { expect(await settle('release', first.token!)).toMatchObject({ status: 'retryable', code: 1 }); }
    finally { if (lock.state === 'acquired') releaseLocalStoreLock(lock.lock); }
  }, 60_000);
  it('binds tombstones to receipt coordinates even if an ordinal is reused', async () => {
    const first = await acquire();
    await settle('complete', first.token!);
    const path = join(root, 'bus-inbox', 'messages.json');
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    rows[0].receivedAt += 1;
    now += 1;
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
    expect(await settle('renew', first.token!)).toMatchObject({ status: 'lost', code: 1 });
    expect((await acquire()).status).toBe('acquired');
  }, 60_000);
  it('refuses oversized and structurally invalid state without replacing it', async () => {
    await acquire();
    const row = JSON.parse(readFileSync(state(), 'utf8'))[0];
    for (const data of [JSON.stringify([{ ...row, body: 'forbidden' }]), ' '.repeat(512 * 1024 + 1)]) {
      writeFileSync(state(), data, { mode: 0o600 });
      expect(await acquire()).toMatchObject({ status: 'unavailable', code: 1 });
      expect(readFileSync(state(), 'utf8')).toBe(data);
    }
  }, 60_000);
  it('recovers an interrupted private stage without promoting its contents', async () => {
    const first = await acquire();
    now += 1000;
    writeFileSync(join(root, 'bus-work-claims', '.pending'), 'partial snapshot', { mode: 0o600 });
    const next = await acquire();
    expect(next.status).toBe('acquired');
    expect(next.token).not.toBe(first.token);
    expect(await settle('renew', first.token!)).toMatchObject({ status: 'mismatched-token', code: 1 });
  }, 60_000);
  it('preserves claims and completion across a fresh process without changing the inbox', async () => {
    const inbox = readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
    const first = await command('acquire', ['--owner', 'worker', '--lease-ms', '10000']);
    const child = (action: string, extra: string[]) => {
      const args = [action, '--id', 'message', ...extra, '--root', root, '--json'];
      const script = `Date.now = () => ${now}; import { cmdFleetBusClaim } from './src/cli/fleet-bus-claim.ts'; process.exitCode = await cmdFleetBusClaim(${JSON.stringify(args)});`;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
      return { code: result.status, status: JSON.parse(result.stdout).status };
    };
    expect(child('acquire', ['--owner', 'second', '--lease-ms', '1000'])).toEqual({ code: 1, status: 'conflict' });
    expect(child('complete', ['--token', first.token!])).toEqual({ code: 0, status: 'completed' });
    expect(child('acquire', ['--owner', 'second', '--lease-ms', '1000'])).toEqual({ code: 1, status: 'completed' });
    expect(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(inbox);
  }, 60_000);
});
