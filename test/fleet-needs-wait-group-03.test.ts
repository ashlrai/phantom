import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsWaitGroup } from '../src/cli/fleet-needs-wait-group.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { waitNeedsMasonGroup } from '../src/core/fleet/needs-mason-wait-group.js';

const idOf = (text: string): string => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const [a, b] = ['Approve the fake deploy', 'Rotate the fake key'];
const [idA, idB] = [idOf(a), idOf(b)];
const dirs: string[] = [];
function ledger(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'needs-wait-group-')); dirs.push(dir);
  const file = join(dir, 'NEEDS-MASON.md'); writeFileSync(file, `- [ ] ${a}\n- [ ] ${b}\n`); return { dir, file };
}
const mark = (file: string, id: string): void => appendFileSync(file, `- [x] resolved ${id} stamp\n`);
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('fleet needs-wait-group', () => {
  it('resolves two items at separate times inside one shared budget', async () => {
    const { dir, file } = ledger();
    setTimeout(() => mark(file, idA), 40); setTimeout(() => mark(file, idB), 90);
    const started = Date.now();
    const r = await waitNeedsMasonGroup({ ids: [idB, idA], timeoutMs: 2000, pollMs: 5, runsDir: dir });
    expect(r).toEqual({ outcome: 'resolved', items: [{ id: idB, status: 'resolved' }, { id: idA, status: 'resolved' }] });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('spends only the one shared budget when an item never resolves', async () => {
    const { dir, file } = ledger(); setTimeout(() => mark(file, idA), 30);
    const started = Date.now();
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 150, pollMs: 5, runsDir: dir });
    expect(r.items.map(i => i.status)).toEqual(['resolved', 'timeout']); expect(r.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(150 + 140); // not 2 x 150 serial
  });

  it('keeps unknown and unavailable distinct and never resolved', async () => {
    const { dir } = ledger(); const ghost = 'nm-000000000000';
    expect(await waitNeedsMasonGroup({ ids: [ghost, idA], timeoutMs: 30, pollMs: 5, runsDir: dir }))
      .toEqual({ outcome: 'timeout', items: [{ id: ghost, status: 'unknown' }, { id: idA, status: 'timeout' }] });
    expect(await waitNeedsMasonGroup({ ids: [ghost], timeoutMs: 30, pollMs: 5, runsDir: dir })).toMatchObject({ outcome: 'unknown' });
    const missing = join(dir, 'nope');
    expect(await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 30, pollMs: 5, runsDir: missing }))
      .toMatchObject({ outcome: 'unavailable', items: [{ status: 'unavailable' }, { status: 'unavailable' }] });
  });

  it('cancels every child on outer abort and removes listeners', async () => {
    const { dir } = ledger(); const outer = new AbortController();
    const [i0, t0, ml] = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.getMaxListeners()];
    const signals: AbortSignal[] = [];
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> => {
      signals.push(signal);
      if (signals.length === 2) setImmediate(() => outer.abort());
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 60_000, pollMs: 10, runsDir: dir, sleep, signal: outer.signal });
    expect(r.outcome).toBe('cancelled'); expect(r.items.every(i => i.status === 'cancelled')).toBe(true);
    expect(signals.every(s => s.aborted)).toBe(true);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), process.getMaxListeners()]).toEqual([i0, t0, ml]);
  });

  it('cancels children when an injected budget timer expires', async () => {
    const { dir } = ledger();
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')), { once: true }));
    const budgetSleep = async (): Promise<void> => { await Promise.resolve(); await new Promise(r => setImmediate(r)); };
    const r = await waitNeedsMasonGroup({ ids: [idA, idB], timeoutMs: 1000, pollMs: 10, runsDir: dir, sleep, budgetSleep });
    expect(r.items.map(i => i.status)).toEqual(['timeout', 'timeout']);
  });

  it('rejects invalid and 33-id input before any read', async () => {
    const { dir } = ledger(); const sleep = vi.fn(); const emit = vi.fn();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const many = Array.from({ length: 33 }, (_, n) => `nm-${n.toString(16).padStart(12, '0')}`);
    const base = ['--timeout-ms', '50', '--runs-dir', dir];
    for (const args of [[], [idA], [idA, ...base, '--timeout-ms', '5'], [idA, idA, ...base], ['bad', ...base], many.concat(base), [idA, '--runs-dir', dir],
      [idA, ...base, '--json', '--json'], [idA, ...base, '--poll-ms', '0'], [idA, '--timeout-ms', '2147483648']]) {
      expect(await cmdFleetNeedsWaitGroup(args, { emit, sleep })).toBe(2);
    }
    expect(emit).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    await expect(waitNeedsMasonGroup({ ids: many, timeoutMs: 5, pollMs: 1, runsDir: dir })).rejects.toThrow(RangeError);
  });

  it('exposes the convention export, help and the JSON shape', async () => {
    expect(resolveFleetSubcommand('needs-wait-group')).toEqual({ module: './fleet-needs-wait-group.js', exportName: 'cmdFleetNeedsWaitGroup' });
    const emit = vi.fn(); expect(await cmdFleetNeedsWaitGroup(['-h'], { emit })).toBe(0);
    const { dir, file } = ledger(); mark(file, idA); mark(file, idB); emit.mockClear();
    expect(await cmdFleetNeedsWaitGroup([idA, idB, '--timeout-ms', '100', '--runs-dir', dir, '--json'], { emit })).toBe(0);
    expect(JSON.parse(emit.mock.calls[0]![0])).toEqual({ outcome: 'resolved', items: [{ id: idA, status: 'resolved' }, { id: idB, status: 'resolved' }] });
    emit.mockClear();
    expect(await cmdFleetNeedsWaitGroup([idA, 'nm-000000000000', '--timeout-ms', '100', '--runs-dir', dir], { emit })).toBe(1);
    expect(emit.mock.calls[0]![0]).toBe(`unknown (2 ids)\nresolved ${idA}\nunknown nm-000000000000`);
  });
});
