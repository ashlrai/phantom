import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ spawn: vi.fn(), call: vi.fn(), stat: vi.fn(), check: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: ports.spawn, spawnSync: () => ({ status: 0 }) }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), lstatSync: ports.stat }));
vi.mock('../src/core/drive/script-bridge.js', () => ({ checkDriveExecutable: ports.check }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ callPool: ports.call }));
import { runNodeWorker } from '../src/core/drive/nodes/worker.js';

const config = { role: 'worker' as const, primary: 'main', backup: 'backup', owner: 'mason', node: 'worker' };
class Child extends EventEmitter {
  pid = 0;
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn(() => { this.emit('close', 1); return true; });
}
let child: Child;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  child = new Child();
  ports.stat.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  ports.check.mockResolvedValue(undefined);
  ports.spawn.mockReturnValue(child);
  ports.call.mockImplementation((_config, verb: string) => ({ demoted: false, result:
    verb === 'join' ? { session: 2 } : verb === 'pull' ? {
      pulled: true, job: { id: 'j', requires: ['codex'], secrets: [], pack: 'pack-1' },
      claim: { nodeId: 'worker', session: 2, jobId: 'j', token: 4, leaderToken: 3, expiresAt: 999999 },
    } : verb === 'renew' ? { expiresAt: 999999 } : verb === 'complete' ? { completed: true } : {} }));
});
afterEach(() => vi.useRealTimers());
async function start() {
  const result = runNodeWorker(config, '/reviewed/runner');
  await Promise.resolve();
  return { result };
}
describe('multi-Mac worker lifecycle', () => {
  it('runs a claimed pack and returns only its bounded artifact reference', async () => {
    const { result } = await start();
    expect(ports.spawn).toHaveBeenCalledWith('/reviewed/runner', ['run'], expect.objectContaining({ detached: true, shell: false }));
    child.stdout.write('{"resultRef":"branch:job-j"}');
    child.emit('close', 0);
    expect(await result).toEqual({ jobId: 'j', completed: true });
    expect(ports.call.mock.calls.find(c => c[1] === 'complete')?.[2]).toContain('branch:job-j');
    expect(ports.call.mock.calls.at(-1)?.[1]).toBe('leave');
  });
  it('never starts when the host pause sentinel is present', async () => {
    ports.stat.mockReturnValue({});
    expect(await runNodeWorker(config, '/reviewed/runner')).toEqual({ held: 'host-paused' });
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.call).not.toHaveBeenCalled();
  });
  it('kills the runner and withholds completion when heartbeat transport fails', async () => {
    const { result } = await start();
    ports.call.mockImplementation(() => { throw new Error('partition'); });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ completed: false, held: 'runner-stopped' });
    expect(child.kill).toHaveBeenCalled();
  });
  it('kills running work on the local KILL sentinel', async () => {
    const { result } = await start();
    ports.stat.mockReturnValue({});
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ completed: false });
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('rejects a successful process without a valid result reference', async () => {
    const { result } = await start();
    child.stdout.write('synthetic unstructured provider output');
    child.emit('close', 0);
    expect(await result).toMatchObject({ completed: false });
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('stops oversized output without returning it to queue state', async () => {
    const { result } = await start();
    child.stdout.write('x'.repeat(4097));
    expect(await result).toMatchObject({ completed: false });
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
});
