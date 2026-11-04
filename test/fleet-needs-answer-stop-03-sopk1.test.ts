import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetNeedsAnswer } from '../src/cli/fleet-needs-answer.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import { awaitNeedsMasonAnswer, NEEDS_MASON_AWAIT_STOP_SLICE_MS } from '../src/core/fleet/needs-mason-answer-await.js';
import { resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const itemText = 'Approve the fake deploy';
const itemId = `nm-${createHash('sha256').update(itemText).digest('hex').slice(0, 12)}`;
let root: string, runsDir: string, busRoot: string, stopFile: string, out: string[], errors: string[];
const unknown = () => ({ status: 'unknown' as const });
/** Fake clock: sleep advances time and records each delay. */
function clock(onSleep?: (calls: number) => void) {
  let t = 1000; const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'needs-answer-stop-'));
  runsDir = join(root, 'runs'); busRoot = join(root, 'fleet'); stopFile = join(root, 'stop.flag');
  mkdirSync(runsDir);
  writeFileSync(join(runsDir, 'NEEDS-MASON.md'), `# fake ledger\n- [ ] ${itemText}\n`);
  out = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation(message => { errors.push(String(message)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('awaitNeedsMasonAnswer stopFile', () => {
  it('returns cancelled with zero reads when the stop file already exists', async () => {
    writeFileSync(stopFile, 'ignored');
    const read = vi.fn(unknown), c = clock();
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, stopFile }, { read, ...c })).toEqual({ status: 'cancelled' });
    expect(read).not.toHaveBeenCalled();
    expect(c.sleeps).toEqual([]);
    expect(readFileSync(stopFile, 'utf8')).toBe('ignored');
  });

  it('cancels within one slice when the file appears mid-poll, without reading again or passing the deadline', async () => {
    const read = vi.fn(unknown);
    const c = clock(calls => { if (calls === 3) writeFileSync(stopFile, ''); });
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 60_000, pollMs: 10_000, stopFile }, { read, ...c })).toEqual({ status: 'cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(c.sleeps).toEqual([250, 250, 250]);
    expect(Math.max(...c.sleeps)).toBeLessThanOrEqual(NEEDS_MASON_AWAIT_STOP_SLICE_MS);
  });

  it('keeps slices inside the deadline and times out when the file never appears', async () => {
    const c = clock();
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 600, pollMs: 400, stopFile }, { read: unknown, ...c })).toEqual({ status: 'timeout' });
    expect(c.sleeps).toEqual([250, 150, 200]);
    expect(existsSync(stopFile)).toBe(false);
  });

  it('finds a real retained answer through the canonical reader while the stop file is missing', async () => {
    const c = clock(calls => {
      if (calls === 2) expect(resolveNeedsMason({ itemId, reply: 'fake go ahead' }, { runsDir, bus: { root: busRoot, now: Date.now }, source: 'cli' })).toMatchObject({ ok: true });
    });
    const result = await awaitNeedsMasonAnswer(itemId, { root: busRoot, timeoutMs: 60_000, pollMs: 300, stopFile }, c);
    expect(result).toEqual(readNeedsMasonAnswer(itemId, { root: busRoot }));
    expect(result).toMatchObject({ status: 'found', answer: { reply: 'fake go ahead' } });
    expect(existsSync(stopFile)).toBe(false);
  });

  it('returns unavailable for a non-ENOENT stat failure, before any read', async () => {
    const read = vi.fn(unknown), stat = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, stopFile }, { read, stat, ...clock() })).toEqual({ status: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns unavailable when a stat failure appears mid-wait', async () => {
    let failing = false;
    const stat = () => { if (failing) throw Object.assign(new Error('io'), { code: 'EIO' }); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
    const c = clock(() => { failing = true; });
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, stopFile }, { read: unknown, stat, ...c })).toEqual({ status: 'unavailable' });
  });

  it('rejects an empty or NUL-bearing stop path as invalid without reading', async () => {
    const read = vi.fn(unknown);
    for (const bad of ['', 'a\0b']) expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 10, stopFile: bad }, { read })).toEqual({ status: 'invalid' });
    expect(read).not.toHaveBeenCalled();
  });

  it('still honours AbortSignal cancellation with a stop file configured', async () => {
    const live = new AbortController(), read = vi.fn(unknown);
    const c = clock(() => live.abort());
    expect(await awaitNeedsMasonAnswer(itemId, { timeoutMs: 5000, stopFile, signal: live.signal }, { read, ...c })).toEqual({ status: 'cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('leaves calls without stopFile on a single full-length sleep and never stats', async () => {
    const stat = vi.fn(), c = clock();
    await awaitNeedsMasonAnswer(itemId, { timeoutMs: 1200, pollMs: 500 }, { read: unknown, stat, ...c });
    expect(c.sleeps).toEqual([500, 500, 200]);
    expect(stat).not.toHaveBeenCalled();
  });

  it('leaves no pending timer after a cancelled wait on the default sleep', async () => {
    vi.useFakeTimers();
    try {
      const wait = awaitNeedsMasonAnswer(itemId, { timeoutMs: 60_000, pollMs: 10_000, stopFile }, { read: unknown });
      await vi.advanceTimersByTimeAsync(100);
      writeFileSync(stopFile, '');
      await vi.advanceTimersByTimeAsync(NEEDS_MASON_AWAIT_STOP_SLICE_MS);
      expect(await wait).toEqual({ status: 'cancelled' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('fleet needs-answer --stop-file', () => {
  it('documents the flag and its --timeout-ms requirement in help', async () => {
    expect(await cmdFleetNeedsAnswer(['--help'])).toBe(0);
    expect(out[0]).toContain('--stop-file PATH');
    expect(out[0]).toMatch(/--stop-file PATH[^\n]*needs --timeout-ms/);
  });

  it('exits 130 with the cancelled JSON, retains the bus message and removes signal handlers', async () => {
    resolveNeedsMason({ itemId, reply: 'fake later' }, { runsDir, bus: { root: busRoot, now: Date.now }, source: 'cli' });
    const store = join(busRoot, 'bus-inbox', 'messages.json'), before = readFileSync(store, 'utf8');
    const read = vi.fn(unknown), signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const c = clock(() => writeFileSync(stopFile, 'secret-free'));
    expect(await cmdFleetNeedsAnswer([itemId, '--bus-root', busRoot, '--timeout-ms', '5000', '--stop-file', stopFile, '--json'], { read, ...c })).toBe(130);
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, status: 'cancelled', itemId });
    expect(read).toHaveBeenCalledTimes(1);
    expect(readFileSync(store, 'utf8')).toBe(before);
    expect(readFileSync(stopFile, 'utf8')).toBe('secret-free');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
    expect(out.join('')).not.toContain('secret-free');
  });

  it('reports a pre-existing stop file as cancelled with zero reads in text mode', async () => {
    writeFileSync(stopFile, '');
    const read = vi.fn(unknown);
    expect(await cmdFleetNeedsAnswer([itemId, '--timeout-ms', '5000', '--stop-file', stopFile], { read })).toBe(130);
    expect(out[0]).toBe(`cancelled ${itemId}`);
    expect(read).not.toHaveBeenCalled();
  });

  it('maps a stat failure to unavailable (exit 1)', async () => {
    const stat = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(await cmdFleetNeedsAnswer([itemId, '--timeout-ms', '5000', '--stop-file', stopFile], { read: unknown, stat })).toBe(1);
    expect(errors.join('')).toContain('needs-answer unavailable');
  });

  it.each([
    ['without timeout', ['--stop-file', 'x.flag']],
    ['duplicate', ['--timeout-ms', '10', '--stop-file', 'a', '--stop-file', 'b']],
    ['missing value', ['--timeout-ms', '10', '--stop-file']],
    ['flag-like value', ['--timeout-ms', '10', '--stop-file', '--json']],
    ['empty value', ['--timeout-ms', '10', '--stop-file', '']],
  ])('rejects %s with exit 2 before any read or stat', async (_name, flags) => {
    const read = vi.fn(unknown), stat = vi.fn();
    expect(await cmdFleetNeedsAnswer([itemId, ...flags], { read, stat, ...clock() })).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(errors.join('')).toContain('--stop-file PATH');
  });
});
