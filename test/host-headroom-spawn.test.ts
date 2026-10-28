import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHostHeadroom } from '../src/core/run/host-headroom.js';
import { spawnEngine } from '../src/core/run/engines.js';
import { appendCustodyRecord } from '../src/core/run/custody-ledger.js';
import type { AshlrConfig } from '../src/core/types.js';

// Exercise the real admission policy and engine path without launching a paid
// engine or reading live host telemetry. Only OS boundaries and ledger are fake.
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('../src/core/run/custody-ledger.js', () => ({ appendCustodyRecord: vi.fn() }));
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  totalmem: vi.fn(() => 137438953472),
}));

const vm = readFileSync(new URL('./fixtures/host-headroom/vm_stat.txt', import.meta.url), 'utf8');
const swap = readFileSync(new URL('./fixtures/host-headroom/swapusage.txt', import.meta.url), 'utf8');
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let swapText = swap;
const cfg = { models: {}, foundry: {}, tools: {}, phantom: { enabled: false } } as unknown as AshlrConfig;
const cmd = { bin: '/test/FAKE-engine', args: [] };

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', undefined);
  checkHostHeadroom(); // Disabled checks reset the process-local window.
  vi.clearAllMocks();
  vi.mocked(totalmem).mockReturnValue(137438953472);
  swapText = swap;
  vi.mocked(execFileSync).mockImplementation(file => {
    if (file === '/usr/bin/vm_stat') return vm;
    if (file === '/usr/sbin/sysctl') return swapText;
    throw new Error('Unexpected test command');
  });
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(), unref: vi.fn(), exitCode: null, signalCode: null,
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('TEST engine completed\n'));
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
});

afterEach(() => {
  vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', undefined);
  checkHostHeadroom();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', platformDescriptor);
});

describe('spawnEngine host memory opt-in', () => {
  it.each([undefined, '0', 'false', 'true', ''])('does not collect or hold unless explicitly enabled (%s)', async value => {
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', value);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('TEST telemetry unavailable'); });
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true, output: 'TEST engine completed' });
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('allows spawnEngine with stale 19.35 GiB swap and flat growth even with low free pages', async () => {
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '1');
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenCalledTimes(4);
    expect(execFileSync).toHaveBeenCalledWith('/usr/sbin/sysctl', ['vm.swapusage'],
      expect.objectContaining({ timeout: 1000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it('holds growth before spawn or custody writes and the kill switch restores launches and resets history', async () => {
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '1');
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    swapText = 'vm.swapusage: total = 32G used = 22G free = 10G';
    const onCustody = vi.fn();
    const refused = await spawnEngine(cmd, cfg, { onCustody });
    expect(refused).toMatchObject({ ok: false, terminationReason: 'error-exit', error: expect.stringContaining('swap grew') });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(appendCustodyRecord).toHaveBeenCalledTimes(1);
    expect(onCustody).not.toHaveBeenCalled();
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '0');
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '1');
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('holds unavailable enabled telemetry without exposing command errors or writing custody', async () => {
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '1');
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('TEST private process details'); });
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: false, error: 'Host memory telemetry unavailable; launch held.' });
    expect(spawn).not.toHaveBeenCalled();
    expect(appendCustodyRecord).not.toHaveBeenCalled();
  });

  it('preserves non-Darwin admission even when enabled', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    vi.stubEnv('ASHLR_HOST_MEMORY_HOLD', '1');
    expect(await spawnEngine(cmd, cfg)).toMatchObject({ ok: true });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
