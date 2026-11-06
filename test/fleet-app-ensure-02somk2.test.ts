import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppEnsure } from '../src/cli/fleet-app-ensure.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const SCRIPT = '/fake/app_control.py';
const status = (running: boolean) => ({ stdout: JSON.stringify({ action: 'status', ok: true, code: 'ok', running }), stderr: '' });
const launchOk = { stdout: JSON.stringify({ action: 'launch', ok: true, code: 'launched' }), stderr: '' };
const launchDenied = { stdout: JSON.stringify({ action: 'launch', ok: false, code: 'permission_denied' }), stderr: '' };

/** Replies are keyed by action; each action consumes its queue, repeating the last entry. */
function harness(replies: { status: Array<{ stdout: string; stderr: string }>; launch?: Array<{ stdout: string; stderr: string }> }, onCall?: (action: string) => void) {
  let t = 0;
  const calls: Array<{ file: string; argv: readonly string[]; timeout: number }> = [];
  const used = { status: 0, launch: 0 };
  const exec = vi.fn(async (file: string, argv: readonly string[], o: { timeout: number }) => {
    calls.push({ file, argv, timeout: o.timeout });
    const action = argv[2] as 'status' | 'launch';
    onCall?.(action);
    const q = replies[action] ?? [{ stdout: 'x', stderr: '' }];
    return q[Math.min(used[action]++, q.length - 1)]!;
  });
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  const locate = vi.fn((_root: string) => SCRIPT);
  const actions = () => calls.map(c => c.argv[2]);
  return { exec, calls, actions, locate, deps: { exec, sleep, now: () => t, locateScript: locate } };
}

let out = '';
beforeEach(() => {
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.ASHLR_RUNS_DIR; });

describe('fleet app-ensure', () => {
  it('already running: one status, no launch', async () => {
    const h = harness({ status: [status(true)] });
    expect(await cmdFleetAppEnsure(['Cursor', '--root', '/r', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(out)).toEqual({ app: 'Cursor', outcome: 'running', launched: false, attempts: 1, running: true });
    expect(h.calls.map(c => [c.file, c.argv])).toEqual([['python3', ['-I', SCRIPT, 'status', 'Cursor', '--output-dir', '/r']]]);
    expect(h.locate).toHaveBeenCalledWith('/r');
  });

  it('stopped: launches exactly once, then observes running', async () => {
    const h = harness({ status: [status(false), status(false), status(true)], launch: [launchOk] });
    expect(await cmdFleetAppEnsure(['Claude', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(out)).toEqual({ app: 'Claude', outcome: 'launched', launched: true, attempts: 3, running: true });
    expect(h.actions()).toEqual(['status', 'launch', 'status', 'status']);
  });

  it('unknown initial status never launches', async () => {
    for (const stdout of ['nope', '{"ok":false,"running":false}', '{"ok":true,"running":"no"}', 'null']) {
      const h = harness({ status: [{ stdout, stderr: '' }] });
      expect(await cmdFleetAppEnsure(['Claude', '--json'], h.deps)).toBe(1);
      expect(JSON.parse(out.trim().split('\n').pop()!)).toMatchObject({ outcome: 'unavailable', launched: false, running: null });
      expect(h.actions()).toEqual(['status']);
    }
  });

  it('permission refusal does not proceed to confirmation', async () => {
    const h = harness({ status: [status(false)], launch: [launchDenied] });
    expect(await cmdFleetAppEnsure(['Safari', '--json'], h.deps)).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'launch-failed', running: false });
    expect(h.actions()).toEqual(['status', 'launch']);
  });

  it('timeout stays a failure after an accepted launch, with one shared deadline', async () => {
    const h = harness({ status: [status(false)], launch: [launchOk] });
    expect(await cmdFleetAppEnsure(['Codex', '--timeout-ms', '3000', '--json'], h.deps)).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ outcome: 'timeout', launched: true, running: false });
    expect(h.actions().filter(a => a === 'launch')).toHaveLength(1);
    expect(h.calls.every(c => c.timeout <= 3000)).toBe(true);
  });

  it('cancelled before start does no work; cancelled after status stops there', async () => {
    const pre = new AbortController();
    pre.abort();
    const a = harness({ status: [status(false)], launch: [launchOk] });
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], { ...a.deps, signal: pre.signal })).toBe(1);
    expect(a.exec).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ outcome: 'cancelled', launched: false });

    const ctl = new AbortController();
    const b = harness({ status: [status(false)], launch: [launchOk] }, () => ctl.abort());
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], { ...b.deps, signal: ctl.signal })).toBe(1);
    expect(b.actions()).toEqual(['status']);
  });

  it('a never-settling status is bounded by the deadline and does not launch', async () => {
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => {}));
    expect(await cmdFleetAppEnsure(['Cursor', '--timeout-ms', '20', '--json'], { exec, locateScript: () => SCRIPT })).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ launched: false, running: null });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('forwards an installed root and does not leak child output', async () => {
    const h = harness({ status: [{ stdout: 'SECRET /Users/x', stderr: 'SECRET' }] });
    await cmdFleetAppEnsure(['Cursor', '--root', '/inst'], h.deps);
    expect(h.calls[0]!.argv.slice(-2)).toEqual(['--output-dir', '/inst']);
    expect(JSON.stringify([vi.mocked(console.error).mock.calls, vi.mocked(console.log).mock.calls])).not.toContain('SECRET');
  });

  it('invalid options start no child and exit 2', async () => {
    const bad = [[], ['Nope'], ['Cursor', '--bogus'], ['Cursor', '--json', '--json'], ['Cursor', '--timeout-ms', '0'],
      ['Cursor', '--timeout-ms', '1.5'], ['Cursor', '--interval-ms'], ['Cursor', '--root', '-x'], ['--help', 'x']];
    for (const args of bad) {
      const h = harness({ status: [status(true)] });
      expect(await cmdFleetAppEnsure(args, h.deps)).toBe(2);
      expect(h.exec).not.toHaveBeenCalled();
      expect(h.locate).not.toHaveBeenCalled();
    }
  });

  it('missing script exits 1 without a child; help exits 0; loader discovers the export', async () => {
    const h = harness({ status: [status(true)] });
    expect(await cmdFleetAppEnsure(['Cursor'], { ...h.deps, locateScript: () => null })).toBe(1);
    expect(h.exec).not.toHaveBeenCalled();
    expect(await cmdFleetAppEnsure(['--help'])).toBe(0);
    expect(vi.mocked(console.log).mock.calls[0]![0]).toContain('Usage: ashlr fleet app-ensure');
    const mod = await FLEET_SUBCOMMAND_LOADERS['app-ensure']!();
    expect(mod.cmdFleetAppEnsure).toBe(cmdFleetAppEnsure);
  });
});
