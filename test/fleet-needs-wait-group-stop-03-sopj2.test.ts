import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWaitGroup } from '../src/cli/fleet-needs-wait-group.js';
import { stopFilePresent, waitNeedsMasonGroup } from '../src/core/fleet/needs-mason-wait-group.js';

const idOf = (text: string): string => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const [a, b] = ['Approve the fake deploy', 'Rotate the fake key'];
const [idA, idB] = [idOf(a), idOf(b)];
const dirs: string[] = [];
function ledger(): { dir: string; file: string; stop: string } {
  const dir = mkdtempSync(join(tmpdir(), 'needs-wait-stop-')); dirs.push(dir);
  const file = join(dir, 'NEEDS-MASON.md'); writeFileSync(file, `- [ ] ${a}\n- [ ] ${b}\n`);
  return { dir, file, stop: join(dir, 'STOP') };
}
const mark = (file: string, id: string): void => appendFileSync(file, `- [x] resolved ${id} stamp\n`);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const listeners = (): number[] => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.getMaxListeners()];
const hang = (_ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));

describe('needs-wait-group --stop-file', () => {
  it('preexisting stop cancels without any child read or sleep', async () => {
    const { dir, stop } = ledger(); writeFileSync(stop, '');
    const sleep = vi.fn(); const before = listeners();
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 60_000, pollMs: 5, runsDir: join(dir, 'missing'), sleep, stopFile: stop });
    expect(r).toEqual({ outcome: 'cancelled', items: [{ id: idA, status: 'cancelled' }, { id: idB, status: 'cancelled' }] });
    expect(sleep).not.toHaveBeenCalled(); expect(listeners()).toEqual(before);
  });

  it('stop appearing mid-wait keeps resolved item and cancels the open one', async () => {
    const { dir, file, stop } = ledger(); const before = listeners();
    mark(file, idA);
    let polls = 0; const stopSleep = async (): Promise<void> => { if (++polls === 3) writeFileSync(stop, ''); };
    const r = await waitNeedsMasonGroup({ ids: [idB, idA], timeoutMs: 60_000, pollMs: 5, runsDir: dir, stopFile: stop, stopSleep });
    expect(r).toEqual({ outcome: 'cancelled', items: [{ id: idB, status: 'cancelled' }, { id: idA, status: 'resolved' }] });
    expect(listeners()).toEqual(before);
  });

  it('real timers: stop file created while waiting cancels within a poll interval', async () => {
    const { dir, stop } = ledger(); setTimeout(() => writeFileSync(stop, ''), 30);
    const started = Date.now();
    const r = await waitNeedsMasonGroup({ ids: [idA], timeoutMs: 5000, pollMs: 10, runsDir: dir, stopFile: stop });
    expect(r.outcome).toBe('cancelled'); expect(Date.now() - started).toBeLessThan(500);
  });

  it('absent stop file leaves resolution and timeout behaviour unchanged', async () => {
    const { dir, file, stop } = ledger(); setTimeout(() => mark(file, idA), 20);
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 120, pollMs: 5, runsDir: dir, stopFile: stop });
    expect(r.items.map(i => i.status)).toEqual(['resolved', 'timeout']); expect(r.outcome).toBe('timeout');
    mark(file, idB);
    expect((await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 120, pollMs: 5, runsDir: dir, stopFile: stop })).outcome).toBe('resolved');
  });

  it('external AbortSignal still cancels and polling stops', async () => {
    const { dir, stop } = ledger(); const outer = new AbortController(); const before = listeners();
    const signals: AbortSignal[] = [];
    const stopSleep = (ms: number, s: AbortSignal): Promise<void> => { signals.push(s); setImmediate(() => outer.abort()); return hang(ms, s); };
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 60_000, pollMs: 5, runsDir: dir, stopFile: stop, stopSleep, signal: outer.signal });
    expect(r.outcome).toBe('cancelled'); expect(signals.every(s => s.aborted)).toBe(true); expect(listeners()).toEqual(before);
  });

  it('budget expiry stays timeout (not cancelled) and cleans the stop poller', async () => {
    const { dir, stop } = ledger(); const signals: AbortSignal[] = [];
    const stopSleep = (ms: number, s: AbortSignal): Promise<void> => { signals.push(s); return hang(ms, s); };
    const r = await waitNeedsMasonGroup({ ids: [idA], timeoutMs: 40, pollMs: 5, runsDir: dir, stopFile: stop, stopSleep });
    expect(r.outcome).toBe('timeout'); expect(signals.length).toBe(1); expect(signals[0]!.aborted).toBe(true);
  });

  it('probe errors are conservative: treated as a stop', async () => {
    const { dir, stop } = ledger();
    const r = await waitNeedsMasonGroup({ ids: [idA], timeoutMs: 1000, pollMs: 5, runsDir: dir, stopFile: stop, stopExists: async () => { throw new Error('EIO'); } });
    expect(r.outcome).toBe('cancelled');
  });

  it('stopFilePresent: absent, present, ENOTDIR absent, EACCES treated as present, never mutates', async () => {
    const { dir, file, stop } = ledger();
    expect(await stopFilePresent(stop)).toBe(false);
    expect(await stopFilePresent(join(file, 'child'))).toBe(false);
    writeFileSync(stop, 'keep'); chmodSync(stop, 0o000);
    expect(await stopFilePresent(stop)).toBe(true);
    const locked = join(dir, 'locked'); const { mkdirSync } = await import('node:fs');
    mkdirSync(locked); writeFileSync(join(locked, 'x'), ''); chmodSync(locked, 0o000);
    try { if (process.getuid?.() !== 0) expect(await stopFilePresent(join(locked, 'x'))).toBe(true); } finally { chmodSync(locked, 0o700); }
    chmodSync(stop, 0o600);
  });

  it('rejects an empty stop path', async () => {
    const { dir } = ledger();
    await expect(waitNeedsMasonGroup({ ids: [idA], timeoutMs: 10, pollMs: 5, runsDir: dir, stopFile: '' })).rejects.toThrow(RangeError);
  });

  it('CLI wires --stop-file and rejects duplicate or valueless flags', async () => {
    const { dir, stop } = ledger(); writeFileSync(stop, '');
    const out: string[] = []; const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleetNeedsWaitGroup([idA, '--timeout-ms', '1000', '--runs-dir', dir, '--stop-file', stop, '--json'], { emit: l => out.push(l) })).toBe(1);
    expect(JSON.parse(out[0]!)).toEqual({ outcome: 'cancelled', items: [{ id: idA, status: 'cancelled' }] });
    const base = [idA, '--timeout-ms', '1000'];
    expect(await cmdFleetNeedsWaitGroup([...base, '--stop-file', stop, '--stop-file', stop])).toBe(2);
    expect(await cmdFleetNeedsWaitGroup([...base, '--stop-file'])).toBe(2);
    expect(await cmdFleetNeedsWaitGroup([...base, '--stop-file', '--json'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
