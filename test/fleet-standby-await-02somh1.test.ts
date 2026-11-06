import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStandbyAwait, type FleetStandbyAwaitDeps } from '../src/cli/fleet-standby-await.js';
import type { FleetStandbyExec } from '../src/cli/fleet-standby.js';

const CONN = ['--db', '/tmp/fake-leases.sqlite', '--snapshot-store', '/tmp/fake-snaps',
  '--primary', 'fake-primary', '--role', 'leader', '--host', 'fake-standby'];
const blocked = { version: 1, ready: false, blockers: ['no-snapshot'], generation: null, wouldLoseSec: null };
const ready = { version: 1, ready: true, blockers: [], generation: 'g1', wouldLoseSec: 12 };

afterEach(() => vi.restoreAllMocks());

function harness(replies: Array<unknown | Error>, probeMs = 0) {
  let clock = 0;
  const calls: Array<{ argv: readonly string[]; timeout: number }> = [];
  const sleeps: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const exec: FleetStandbyExec = async (_file, argv, options) => {
    calls.push({ argv, timeout: options.timeout });
    running++; maxRunning = Math.max(maxRunning, running);
    clock += probeMs;
    running--;
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { stdout: typeof reply === 'string' ? reply : JSON.stringify(reply), stderr: 'SECRET-STDERR' };
  };
  const deps: FleetStandbyAwaitDeps = {
    exec, locateScript: () => '/fake/standby_readiness.py', now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  };
  return { deps, calls, sleeps, maxRunning: () => maxRunning };
}

async function run(args: string[], deps: FleetStandbyAwaitDeps) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m) => { out.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m) => { err.push(String(m)); });
  vi.spyOn(process.stdout, 'write').mockImplementation((m) => { out.push(String(m)); return true; });
  const code = await cmdFleetStandbyAwait(args, deps);
  return { code, out: out.join(''), err: err.join('') };
}

describe('fleet standby-await', () => {
  it('blocked then ready finishes without real sleeping', async () => {
    const h = harness([blocked, ready]);
    const r = await run(['--timeout-ms', '60000', '--interval-ms', '200', '--json', ...CONN], h.deps);
    expect(r.code).toBe(0);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([200]);
    expect(JSON.parse(r.out)).toEqual({ outcome: 'ready', attempts: 2, elapsedMs: 200, lastReport: ready });
    expect(h.calls[0]!.argv).toEqual(['-B', '/fake/standby_readiness.py', ...CONN]);
  });

  it('initial ready takes one probe and prints a human line', async () => {
    const h = harness([ready]);
    const r = await run(['--timeout-ms', '1000', ...CONN], h.deps);
    expect(r).toMatchObject({ code: 0, out: 'Standby is ready to take over.' });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('permanent blockers hit the deadline with exit 3 and the last report', async () => {
    const h = harness([blocked]);
    const r = await run(['--timeout-ms', '1000', '--interval-ms', '300', '--json', ...CONN], h.deps);
    expect(r.code).toBe(3);
    const o = JSON.parse(r.out);
    expect(o).toMatchObject({ outcome: 'timeout', attempts: 4, elapsedMs: 1000, lastReport: blocked });
  });

  it('timeout smaller than interval does not oversleep', async () => {
    const h = harness([blocked]);
    const r = await run(['--timeout-ms', '150', '--interval-ms', '5000', '--json', ...CONN], h.deps);
    expect(r.code).toBe(3);
    expect(h.sleeps).toEqual([150]);
    expect(JSON.parse(r.out).elapsedMs).toBe(150);
  });

  it('a slow probe consumes the budget and no second child starts; child timeout is capped', async () => {
    const h = harness([blocked], 5000);
    const r = await run(['--timeout-ms', '5000', '--json', ...CONN], h.deps);
    expect(r.code).toBe(3);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.timeout).toBe(5000);
    expect(h.maxRunning()).toBe(1);
    const big = harness([ready]);
    await run(['--timeout-ms', '3600000', ...CONN], big.deps);
    expect(big.calls[0]!.timeout).toBe(30_000);
  });

  it('a probe killed by the shrinking budget is a timeout, not an error', async () => {
    const killed = Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' });
    const h = harness([killed]);
    const r = await run(['--timeout-ms', '500', '--json', ...CONN], h.deps);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ outcome: 'timeout', lastReport: null });
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['non-object JSON', '[]'],
    ['arbitrary JSON', { ok: true }],
    ['ready with blockers', { ...ready, blockers: ['x'] }],
    ['blocked without blockers', { ...ready, ready: false }],
    ['wrong version', { ...ready, version: 2 }],
    ['non-string blocker', { ...blocked, blockers: [1] }],
  ])('%s fails closed with exit 1', async (_n, reply) => {
    const h = harness([reply as unknown]);
    const r = await run(['--timeout-ms', '1000', '--json', ...CONN], h.deps);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ outcome: 'error', attempts: 1, lastReport: null });
    expect(r.out + r.err).not.toContain('SECRET-STDERR');
  });

  it('child failure and missing script return error without leaking details', async () => {
    const h = harness([Object.assign(new Error('spawn /secret/path ENOENT'), { code: 'ENOENT' })]);
    const r = await run(['--timeout-ms', '1000', ...CONN], h.deps);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('/secret/path');
    const m = harness([ready]);
    const none = await run(['--timeout-ms', '1000', '--json', ...CONN], { ...m.deps, locateScript: () => null });
    expect(none.code).toBe(1);
    expect(JSON.parse(none.out)).toMatchObject({ outcome: 'error', attempts: 0 });
    expect(m.calls).toHaveLength(0);
  });

  it('keeps a readable report from a non-zero exit', async () => {
    const h = harness([Object.assign(new Error('x'), { code: 1, stdout: JSON.stringify(ready) })]);
    expect((await run(['--timeout-ms', '1000', ...CONN], h.deps)).code).toBe(0);
  });

  it('uses saved config from a temporary runsDir with fake hosts', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'standby-await-'));
    writeFileSync(join(runsDir, 'standby.json'), JSON.stringify({
      v: 1, db: '/tmp/fake-leases.sqlite', snapshotStore: '/tmp/fake-snaps',
      primary: 'fake-primary', role: 'leader', host: 'fake-standby', maxAgeSec: 600,
    }));
    const h = harness([ready]);
    const r = await run(['--timeout-ms', '1000'], { ...h.deps, runsDir });
    expect(r.code).toBe(0);
    expect(h.calls[0]!.argv).toEqual(['-B', '/fake/standby_readiness.py', ...CONN, '--max-age', '600']);
  });

  it.each([
    ['missing timeout', CONN],
    ['zero timeout', ['--timeout-ms', '0', ...CONN]],
    ['huge timeout', ['--timeout-ms', '3600001', ...CONN]],
    ['fractional timeout', ['--timeout-ms', '1.5', ...CONN]],
    ['low interval', ['--timeout-ms', '1000', '--interval-ms', '99', ...CONN]],
    ['high interval', ['--timeout-ms', '1000', '--interval-ms', '60001', ...CONN]],
    ['duplicate timeout', ['--timeout-ms', '1000', '--timeout-ms', '2000', ...CONN]],
    ['duplicate json', ['--timeout-ms', '1000', '--json', '--json', ...CONN]],
    ['missing value', ['--timeout-ms']],
    ['flag as value', ['--timeout-ms', '--json', ...CONN]],
    ['unknown flag', ['--timeout-ms', '1000', '--bogus', ...CONN]],
    ['bad host', ['--timeout-ms', '1000', ...CONN.slice(0, -1), 'bad host']],
    ['no config at all', ['--timeout-ms', '1000']],
  ])('%s exits 2 and runs zero children', async (_n, args) => {
    const h = harness([ready]);
    const runsDir = mkdtempSync(join(tmpdir(), 'standby-await-empty-'));
    const r = await run(args, { ...h.deps, runsDir });
    expect(r.code).toBe(2);
    expect(h.calls).toHaveLength(0);
  });

  it('--help exits 0 without probing', async () => {
    const h = harness([ready]);
    expect((await run(['--help'], h.deps)).code).toBe(0);
    expect(h.calls).toHaveLength(0);
  });
});
