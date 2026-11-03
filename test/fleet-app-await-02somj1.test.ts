import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppAwait } from '../src/cli/fleet-app-await.js';
import { awaitAppState } from '../src/core/fleet/app-await.js';

const SCRIPT = '/fake/app_control.py';
const ok = (running: boolean) => ({ stdout: JSON.stringify({ action: 'status', ok: true, code: 'ok', running }), stderr: '' });

function harness(replies: Array<() => Promise<{ stdout: string; stderr: string }>>) {
  let t = 0;
  let inflight = 0;
  let maxInflight = 0;
  const calls: Array<{ file: string; argv: readonly string[]; timeout: number }> = [];
  const exec = vi.fn(async (file: string, argv: readonly string[], o: { timeout: number }) => {
    calls.push({ file, argv, timeout: o.timeout });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try { return await (replies[Math.min(calls.length - 1, replies.length - 1)]!)(); } finally { inflight--; }
  });
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const locate = vi.fn((_root: string) => SCRIPT);
  return { exec, sleep, locate, calls, now: () => t, max: () => maxInflight, deps: { exec, sleep, now: () => t, locateScript: locate } };
}

let out = '';
beforeEach(() => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.ASHLR_RUNS_DIR; });

describe('fleet app-await', () => {
  it('false -> true satisfies running with fixed status-only argv, one probe at a time', async () => {
    const h = harness([async () => ok(false), async () => ok(true)]);
    expect(await cmdFleetAppAwait(['Cursor', '--state', 'running', '--root', '/r', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(out)).toEqual({ app: 'Cursor', target: 'running', outcome: 'reached', attempts: 2, running: true, elapsedMs: 1000 });
    expect(h.calls.map(c => [c.file, c.argv])).toEqual(
      Array(2).fill(['python3', ['-I', SCRIPT, 'status', 'Cursor', '--output-dir', '/r']]));
    expect(h.max()).toBe(1);
    expect(h.locate).toHaveBeenCalledWith('/r');
  });

  it('true -> false satisfies stopped', async () => {
    const h = harness([async () => ok(true), async () => ok(false)]);
    expect(await cmdFleetAppAwait(['Grok Bot', '--state', 'stopped', '--root', '/r'], h.deps)).toBe(0);
    expect(console.log).toHaveBeenCalledWith('Grok Bot: stopped');
  });

  it('running:false never satisfies running', async () => {
    const h = harness([async () => ok(false)]);
    expect(await cmdFleetAppAwait(['Claude', '--state', 'running', '--timeout-ms', '3000', '--json'], h.deps)).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'timeout', running: false });
  });

  it('invalid JSON, ok:false and non-boolean running never count as stopped', async () => {
    for (const stdout of ['not json', '{"ok":false,"running":false}', '{"ok":true,"running":"no"}', 'null']) {
      const h = harness([async () => ({ stdout, stderr: '' })]);
      expect(await cmdFleetAppAwait(['Claude', '--state', 'stopped', '--timeout-ms', '2500', '--json'], h.deps)).toBe(1);
      expect(JSON.parse(out.trim().split('\n').pop()!)).toMatchObject({ outcome: 'unavailable', running: null });
    }
  });

  it('subprocess failures exhaust the budget without leaking output', async () => {
    const h = harness([async () => { throw Object.assign(new Error('boom /Users/secret'), { stdout: 'x', stderr: 'y' }); }]);
    expect(await cmdFleetAppAwait(['Safari', '--state', 'running', '--timeout-ms', '3000', '--json'], h.deps)).toBe(1);
    expect(out).not.toMatch(/secret|boom/);
    expect(Object.keys(JSON.parse(out)).sort()).toEqual(['app', 'attempts', 'elapsedMs', 'outcome', 'running', 'target']);
    expect(h.calls.at(-1)!.timeout).toBeLessThanOrEqual(1000);
  });

  it('no further probe after the deadline; probe timeout is clamped to remaining budget', async () => {
    const h = harness([async () => ok(false)]);
    await cmdFleetAppAwait(['Codex', '--state', 'running', '--timeout-ms', '2500', '--interval-ms', '1000'], h.deps);
    expect(h.calls.map(c => c.timeout)).toEqual([2500, 1500, 500]);
    expect(h.sleep.mock.calls.map(c => c[0])).toEqual([1000, 1000, 500]);
    expect(h.calls).toHaveLength(3);
  });

  it('a never-resolving probe is cut off by the wall deadline', async () => {
    const exec = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();
    expect(await cmdFleetAppAwait(['Phantom', '--state', 'running', '--timeout-ms', '40', '--json'], { exec, locateScript: () => SCRIPT })).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'unavailable', attempts: 1 });
  });

  it('pre-aborted signal exits 1 cancelled with no probe', async () => {
    const h = harness([async () => ok(true)]);
    const ac = new AbortController();
    ac.abort();
    expect(await cmdFleetAppAwait(['Phantom', '--state', 'running', '--json'], { ...h.deps, signal: ac.signal })).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'cancelled', attempts: 0 });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('abort settles a pending probe and a pending sleep', async () => {
    for (const mode of ['probe', 'sleep'] as const) {
      const ac = new AbortController();
      const r = awaitAppState({
        target: 'running', timeoutMs: 60_000, intervalMs: 10, signal: ac.signal,
        probe: mode === 'probe' ? () => new Promise<never>(() => {}) : async () => false,
        sleep: () => new Promise<void>(() => {}),
      });
      setTimeout(() => ac.abort(), 10);
      expect(await r).toMatchObject({ outcome: 'cancelled' });
    }
  });

  it('--root reaches locator and --output-dir; env root is the fallback', async () => {
    const h = harness([async () => ok(true)]);
    await cmdFleetAppAwait(['Cursor', '--state', 'running', '--root', '/explicit'], h.deps);
    expect(h.locate).toHaveBeenLastCalledWith('/explicit');
    process.env.ASHLR_RUNS_DIR = '/from-env';
    await cmdFleetAppAwait(['Cursor', '--state', 'running'], h.deps);
    expect(h.locate).toHaveBeenLastCalledWith('/from-env');
    expect(h.calls.at(-1)!.argv.at(-1)).toBe('/from-env');
  });

  it('missing bridge returns 1 promptly without spawning', async () => {
    const exec = vi.fn();
    expect(await cmdFleetAppAwait(['Cursor', '--state', 'running'], { exec, locateScript: () => null })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('malformed arguments exit 2 and spawn/locate nothing', async () => {
    const bad = [
      [], ['Cursor'], ['Nope', '--state', 'running'], ['--state', 'running'],
      ['Cursor', '--state'], ['Cursor', '--state', 'paused'], ['Cursor', '--state', 'running', '--state', 'stopped'],
      ['Cursor', '--state', 'running', '--json', '--json'], ['Cursor', '--state', 'running', '--root'],
      ['Cursor', '--state', 'running', '--root', '--json'], ['Cursor', '--state', 'running', '--bogus'],
      ['Cursor', '--state', 'running', '--timeout-ms', '0'], ['Cursor', '--state', 'running', '--timeout-ms', '-5'],
      ['Cursor', '--state', 'running', '--timeout-ms', '1.5'], ['Cursor', '--state', 'running', '--timeout-ms', 'abc'],
      ['Cursor', '--state', 'running', '--timeout-ms', 'Infinity'], ['Cursor', '--state', 'running', '--interval-ms', '1e3'],
      ['Cursor', '--state', 'running', '--interval-ms', '0'],
    ];
    for (const args of bad) {
      const exec = vi.fn();
      const locateScript = vi.fn(() => SCRIPT);
      expect(await cmdFleetAppAwait(args, { exec, locateScript }), JSON.stringify(args)).toBe(2);
      expect(exec).not.toHaveBeenCalled();
      expect(locateScript).not.toHaveBeenCalled();
    }
  });

  it('caps timeout at 300000 ms', async () => {
    const h = harness([async () => ok(false)]);
    await cmdFleetAppAwait(['Cursor', '--state', 'running', '--timeout-ms', '999999999', '--interval-ms', '100000'], h.deps);
    expect(h.calls[0]!.timeout).toBe(300_000);
    expect(h.now()).toBe(300_000);
  });
});
