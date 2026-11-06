import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as processIdentity from '../src/core/fleet/local-store-lock.js';
import { selfSwapRuntime } from '../src/core/daemon/self-swap-runtime.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, realpathSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySelfSwap, planSelfSwap, type SelfSwapOptions, type SelfSwapRuntime } from '../src/core/daemon/self-swap.js';
import * as durability from '../src/core/util/durability.js';
import { cmdSelfSwap } from '../src/cli/self-swap.js';

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }));

const identity = { source: 'ps-lstart' as const, ref: 'a'.repeat(64), epochSecond: 123 };
let root: string;
let options: SelfSwapOptions;
let runtime: SelfSwapRuntime;
let healthy: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
const selected = () => readlinkSync(join(root, 'current'));
const journal = (phase = 'probing', extra = {}) => writeFileSync(join(root, '.self-swap.json'), JSON.stringify({
  previous: 'v1', next: 'v2', oldPid: 12345, identity, phase, ...extra,
}), { mode: 0o600 });
const select = (name: string) => { unlinkSync(join(root, 'current')); symlinkSync(`versions/${name}`, join(root, 'current')); };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'self-swap-test-')));
  for (const name of ['v1', 'v2', 'v3']) mkdirSync(join(root, 'versions', name), { recursive: true });
  if (process.platform !== 'win32') symlinkSync('versions/v1', join(root, 'current'));
  options = { root, next: 'v2', oldPid: 12345, sparePort: 0 };
  healthy = vi.fn().mockResolvedValue(true);
  close = vi.fn().mockResolvedValue(undefined);
  runtime = { identify: vi.fn().mockReturnValue(identity), build: vi.fn().mockResolvedValue(undefined),
    probe: vi.fn().mockResolvedValue({ healthy, close }), drain: vi.fn().mockResolvedValue(undefined) };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

if (process.platform === 'win32') {
  it('refuses unsupported Windows apply without runtime effects', async () => {
    await expect(applySelfSwap(options, runtime)).rejects.toThrow('POSIX');
    expect(runtime.build).not.toHaveBeenCalled();
  });
} else {
  describe('versioned self-swap transaction', () => {
    it('plans without writes or runtime effects', () => {
      const before = readdirSync(root);
      expect(planSelfSwap(options)).toMatchObject({ mode: 'plan', previous: 'v1', next: 'v2' });
      expect(readdirSync(root)).toEqual(before);
      expect(runtime.build).not.toHaveBeenCalled();
    });
    it('builds next, flips atomically, reprobes and drains only after commit', async () => {
      healthy.mockImplementation(async () => {
        expect(['versions/v1', 'versions/v2']).toContain(selected());
        return true;
      });
      runtime.drain = vi.fn(async () => {
        expect(selected()).toBe('versions/v2');
        expect(close).toHaveBeenCalled();
      });
      await expect(applySelfSwap(options, runtime)).resolves.toEqual({ mode: 'applied', current: 'v2' });
      expect(runtime.build).toHaveBeenCalledWith(join(root, 'versions/v2'));
      expect(runtime.probe).toHaveBeenCalledWith(join(root, 'versions/v2'), 0);
      expect(healthy).toHaveBeenCalledTimes(2);
      expect(runtime.drain).toHaveBeenCalledWith(12345, identity);
      expect(existsSync(join(root, '.self-swap.json'))).toBe(false);
    });
    it('preserves current and never drains after a failed initial probe', async () => {
      healthy.mockResolvedValue(false);
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('health probe failed');
      expect(selected()).toBe('versions/v1');
      expect(runtime.drain).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    });
    it('rolls back a failed post-flip probe before draining', async () => {
      healthy.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
        expect(selected()).toBe('versions/v2'); return false;
      });
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('post-flip');
      expect(selected()).toBe('versions/v1');
      expect(runtime.drain).not.toHaveBeenCalled();
      expect(existsSync(join(root, '.self-swap.json'))).toBe(false);
    });
    it.each(['v1', 'v2'])('recovers interrupted flip with current at %s without rebuilding or draining', async selectedVersion => {
      journal(); select(selectedVersion);
      await expect(applySelfSwap(options, runtime)).resolves.toEqual({ mode: 'recovered', current: 'v1' });
      expect(selected()).toBe('versions/v1');
      expect(runtime.build).not.toHaveBeenCalled();
      expect(runtime.drain).not.toHaveBeenCalled();
    });
    it('finishes an interrupted committed drain without rolling back a stopped process', async () => {
      journal('draining'); select('v2');
      await expect(applySelfSwap(options, runtime)).resolves.toEqual({ mode: 'applied', current: 'v2' });
      expect(runtime.build).not.toHaveBeenCalled();
      expect(runtime.drain).toHaveBeenCalledWith(12345, identity);
    });
    it('keeps committed selection and journal on drain failure, then retries only drain', async () => {
      vi.mocked(runtime.drain).mockRejectedValueOnce(new Error('timeout'));
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('timeout');
      expect(selected()).toBe('versions/v2');
      expect(existsSync(join(root, '.self-swap.json'))).toBe(true);
      await expect(applySelfSwap(options, runtime)).resolves.toMatchObject({ mode: 'applied' });
      expect(runtime.build).toHaveBeenCalledTimes(1);
    });
    it('refuses to overwrite an unrelated selection during recovery', async () => {
      journal(); select('v3');
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('outside self-swap');
      expect(selected()).toBe('versions/v3');
      expect(runtime.drain).not.toHaveBeenCalled();
    });
    it('serializes concurrent apply attempts', async () => {
      runtime.build = vi.fn(async () => {
        await expect(applySelfSwap(options, runtime)).rejects.toThrow('busy');
      });
      await expect(applySelfSwap(options, runtime)).resolves.toMatchObject({ mode: 'applied' });
    });
    it('does not probe or change current when building fails', async () => {
      vi.mocked(runtime.build).mockRejectedValue(new Error('build failure'));
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('build failure');
      expect(runtime.probe).not.toHaveBeenCalled();
      expect(selected()).toBe('versions/v1');
    });
    it('fences interrupted builds so orphan writers cannot race a later flip', async () => {
      journal('building');
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('Interrupted build');
      expect(runtime.build).not.toHaveBeenCalled();
      expect(selected()).toBe('versions/v1');
    });
    it('does not drain after an ambiguous commit write and recovers on the next apply', async () => {
      const original = durability.fsyncDirectory;
      const fault = vi.spyOn(durability, 'fsyncDirectory').mockImplementation((path, opts) => {
        const record = join(root, '.self-swap.json');
        if (path === root && existsSync(record) && JSON.parse(readFileSync(record, 'utf8')).phase === 'draining') throw new Error('fsync failure');
        return original(path, opts);
      });
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('fsync failure');
      expect(runtime.drain).not.toHaveBeenCalled();
      expect(selected()).toBe('versions/v2');
      fault.mockRestore();
      await expect(applySelfSwap(options, runtime)).resolves.toMatchObject({ mode: 'applied' });
      expect(runtime.build).toHaveBeenCalledTimes(1);
    });
    it('refuses a third selection changed during the post-flip probe', async () => {
      healthy.mockResolvedValueOnce(true).mockImplementationOnce(async () => { select('v3'); return true; });
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('outside self-swap');
      expect(selected()).toBe('versions/v3');
      expect(runtime.drain).not.toHaveBeenCalled();
    });
    it('rejects a journal writable by other users', async () => {
      journal('draining'); chmodSync(join(root, '.self-swap.json'), 0o666);
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('Invalid');
      expect(runtime.drain).not.toHaveBeenCalled();
    });
    it('requires an identifiable old process before building', async () => {
      vi.mocked(runtime.identify).mockReturnValue(undefined);
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('identity');
      expect(runtime.build).not.toHaveBeenCalled();
    });
    it.each(['../escape', 'v1', '', '/tmp/escape'])('refuses invalid candidate %s', name => {
      expect(() => planSelfSwap({ ...options, next: name })).toThrow();
    });
    it('rejects linked version directories', () => {
      symlinkSync(join(root, 'versions/v2'), join(root, 'versions/alias'));
      expect(() => planSelfSwap({ ...options, next: 'alias' })).toThrow('real directory');
    });
    it('rejects malformed recovery journals without signaling', async () => {
      journal('draining', { oldPid: -1 });
      await expect(applySelfSwap(options, runtime)).rejects.toThrow('Invalid');
      expect(runtime.drain).not.toHaveBeenCalled();
    });
  });

  describe('self-swap CLI', () => {
    it('defaults to a JSON plan and performs no writes', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const before = readdirSync(root);
      expect(await cmdSelfSwap([])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ mode: 'plan', executable: false });
      log.mockClear();
      expect(await cmdSelfSwap(['--root', root, '--next', 'v2', '--old-pid', '12345'])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ mode: 'plan', previous: 'v1' });
      expect(readdirSync(root)).toEqual(before);
    });
    it.each([['--apply'], ['--apply', '--plan', '--supervised'], ['--unknown'], ['--next'], ['--json', '--json']])('rejects unsafe or malformed options %j', async (...args) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdSelfSwap(args)).toBe(2);
      expect(selected()).toBe('versions/v1');
    });
  });


  describe('self-swap runtime boundary', () => {
    function probeChild() {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true,
        disconnect: vi.fn(() => { child.connected = false; child.emit('exit', 0); }),
        kill: vi.fn(() => { child.emit('exit', 1); return true; }),
      });
      vi.mocked(spawn).mockImplementation(() => {
        queueMicrotask(() => child.emit('message', { port: 43210 }));
        return child as unknown as ChildProcess;
      });
      return child;
    }
    it('probes its owned port with an isolated environment and suppresses all child output', async () => {
      const child = probeChild();
      vi.stubEnv('NODE_OPTIONS', 'must-not-be-inherited');
      const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
      vi.stubGlobal('fetch', fetcher);
      const probe = await selfSwapRuntime.probe(root, 0);
      const args = vi.mocked(spawn).mock.calls.at(-1)!;
      const settings = args[2] as { env: Record<string, string>; stdio: string[] };
      expect(settings.env.NODE_OPTIONS).toBeUndefined();
      expect(settings.env.ASHLR_ADOPTION_AUTO).toBe('0');
      expect(settings.env.HOME).not.toBe(process.env.HOME);
      expect(settings.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
      expect(await probe.healthy()).toBe(true);
      expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:43210/api/health', expect.objectContaining({ redirect: 'error' }));
      await probe.close(); await probe.close();
      expect(child.disconnect).toHaveBeenCalledTimes(1);
      expect(existsSync(settings.env.HOME!)).toBe(false);
    });
    it('rejects unsuccessful health responses', async () => {
      probeChild();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 503 })));
      const probe = await selfSwapRuntime.probe(root, 0);
      expect(await probe.healthy()).toBe(false);
      await probe.close();
    });
    it('cleans the candidate after startup failure', async () => {
      const child = probeChild();
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => child.emit('error', new Error('startup failure')));
        return child as unknown as ChildProcess;
      });
      await expect(selfSwapRuntime.probe(root, 0)).rejects.toThrow('before readiness');
      expect(child.disconnect).toHaveBeenCalled();
    });
    it('does not signal a reused PID', async () => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.spyOn(processIdentity, 'verifiedProcessStartIdentity').mockReturnValue({ ...identity, ref: 'b'.repeat(64) });
      await selfSwapRuntime.drain(12345, identity);
      expect(kill.mock.calls).toEqual([[12345, 0]]);
    });
    it('fails closed if old process identity is unavailable', async () => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.spyOn(processIdentity, 'verifiedProcessStartIdentity').mockReturnValue(undefined);
      await expect(selfSwapRuntime.drain(12345, identity)).rejects.toThrow('verify');
      expect(kill.mock.calls).toEqual([[12345, 0]]);
    });
    it('uses a monotonic drain deadline without escalating to SIGKILL', async () => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.spyOn(processIdentity, 'verifiedProcessStartIdentity').mockReturnValue(identity);
      vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30_000);
      await expect(selfSwapRuntime.drain(12345, identity)).rejects.toThrow('timed out');
      expect(kill.mock.calls).toEqual([[12345, 0], [12345, 'SIGTERM']]);
    });
    it('gracefully signals the same process and waits for its disappearance', async () => {
      let stopped = false;
      const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (stopped) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (signal === 'SIGTERM') stopped = true;
        return true;
      });
      vi.spyOn(processIdentity, 'verifiedProcessStartIdentity').mockReturnValue(identity);
      await selfSwapRuntime.drain(12345, identity);
      expect(kill.mock.calls).toEqual([[12345, 0], [12345, 'SIGTERM'], [12345, 0]]);
    });
  });

}
