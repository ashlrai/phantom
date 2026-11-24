import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ spawn: vi.fn(), call: vi.fn(), stat: vi.fn(), check: vi.fn(), capacity: vi.fn(), hostStats: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: ports.spawn, spawnSync: () => ({ status: 0 }) }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), lstatSync: ports.stat }));
vi.mock('../src/core/drive/script-bridge.js', () => ({ checkDriveExecutable: ports.check }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ callPool: ports.call }));
vi.mock('../src/core/drive/nodes/capacity.js', () => ({ readNodeCapacity: ports.capacity,
  nodeRamSlots: () => 4, sampleHostStats: ports.hostStats }));
vi.mock('../src/core/drive/nodes/host-slots.js', () => ({ hostSlots: () => ({ acquire: ports.acquire }) }));
vi.mock('../src/core/drive/nodes/provider-binary.js', async original => ({ ...await original<typeof import('../src/core/drive/nodes/provider-binary.js')>(),
  resolveProviderBinary: (provider: string) => `/usr/local/bin/${provider}` }));
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
  ports.capacity.mockReturnValue({ slots: 1, ramBytes: 16 * 1024 ** 3, held: null });
  ports.acquire.mockImplementation(() => ({ release: ports.release }));
  ports.hostStats.mockImplementation(() => ({ sampledAtMs: Date.now(), uptimeSeconds: 1, load: [0, 0, 0], ramTotal: 16, ramUsed: 8, diskFree: 4, cores: [] }));
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
  it('continues fenced work when optional host telemetry cannot be collected', async () => {
    ports.hostStats.mockImplementation(() => { throw new Error('unavailable'); });
    const { result } = await start();
    const beatArgs = ports.call.mock.calls.find(c => c[1] === 'beat')![2] as string[];
    expect(beatArgs).not.toContain('--host-stats');
    expect(JSON.parse(beatArgs[beatArgs.indexOf('--capacity') + 1]!)).toMatchObject({ slots: 1, held: null,
      ramBytes: 16 * 1024 ** 3, hostId: expect.any(String), sampledAtMs: Date.now() });
    child.stdout.write('{"resultRef":"branch:job-j"}'); child.emit('close', 0);
    expect(await result).toEqual({ jobId: 'j', completed: true });
  });
  it('advertises its phm build as a capability on join without adding a join flag', async () => {
    const { result } = await start();
    const join = ports.call.mock.calls.find(c => c[1] === 'join')![2] as string[];
    expect(join.filter(a => a.startsWith('--'))).toEqual(['--node', '--caps', '--slots']);
    expect(join[join.indexOf('--caps') + 1]).toMatch(/^codex,claude,phm-\d+\.\d+\.\d+/);
    child.stdout.write('{"resultRef":"branch:job-j"}'); child.emit('close', 0);
    await result;
  });
  it('runs the fixed muse light slice in two slots without a provider lane', async () => {
    ports.capacity.mockReturnValue({ slots: 2, held: null });
    const route = ports.call.getMockImplementation()!;
    let pulls = 0;
    ports.call.mockImplementation((...args) => {
      if (args[1] === 'status') return { result: { jobs: [], nodes: [{ nodeId: 'muse', owners: ['ashlr'],
        caps: ['light', 'comms'], slots: 2, usage: 0, live: true, heartbeatAt: Date.now(), expiresAt: Date.now() + 30_000 }] } };
      const response = route(...args);
      if (args[1] === 'pull') {
        const id = `muse-light-channels-status-${++pulls}`;
        response.result.job = { id, owner: 'ashlr', requires: ['light', 'comms'], secrets: [], pack: 'muse-light:channels-status:v1' };
        response.result.claim.jobId = id;
      }
      return response;
    });
    const second = new Child();
    ports.spawn.mockReturnValueOnce(child).mockReturnValueOnce(second);
    const result = runNodeWorker({ ...config, node: 'muse', owner: 'ashlr' }, '/reviewed/runner', true);
    await Promise.resolve();
    expect(ports.capacity).toHaveBeenCalledWith(true);
    expect(ports.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    const beats = ports.call.mock.calls.filter(c => c[1] === 'beat');
    expect(beats.at(-1)?.[2]).toEqual(expect.arrayContaining(['--usage', '1000', '--slots', '2']));
    const beatArgs = beats.at(-1)![2] as string[];
    expect(JSON.parse(beatArgs[beatArgs.indexOf('--host-stats') + 1]!)).toMatchObject({ ramTotal: 16, load: [0, 0, 0] });
    child.stdout.write('{"resultRef":"light:first"}'); child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(3000);
    const later = ports.call.mock.calls.filter(c => c[1] === 'beat');
    expect(later.at(-1)?.[2]).toEqual(expect.arrayContaining(['--usage', '500']));
    expect(ports.call.mock.calls.some(c => c[1] === 'leave')).toBe(false);
    second.stdout.write('{"resultRef":"light:second"}'); second.emit('close', 0);
    expect(await result).toMatchObject({ slots: 2, attempts: [{ completed: true }, { completed: true }] });
  });

  it('runs a claimed pack and returns only its bounded artifact reference', async () => {
    const { result } = await start();
    expect(ports.spawn).toHaveBeenCalledWith('/reviewed/runner', ['run'], expect.objectContaining({ detached: true, shell: false }));
    child.stdout.write('{"resultRef":"branch:job-j"}');
    child.emit('close', 0);
    expect(await result).toEqual({ jobId: 'j', completed: true });
    expect(ports.call.mock.calls.find(c => c[1] === 'complete')?.[2]).toContain('branch:job-j');
    expect(ports.call.mock.calls.at(-1)?.[1]).toBe('leave');
  });
  it('sends the probed absolute binary as a lane receipt in the runner envelope', async () => {
    const { result } = await start();
    const sent = JSON.parse(String(child.stdin.read()));
    expect(sent).toMatchObject({ protocol: 'phm-node-worker/v1', providerBinaries: { codex: '/usr/local/bin/codex' } });
    expect(sent.providerBinaries).not.toHaveProperty('claude');
    child.stdout.write('{"resultRef":"branch:job-j"}'); child.emit('close', 0);
    await result;
  });
  it.each([
    ['{"resultRef":"branch:job-j","packError":"codex-exit-nonzero"}', 0, 'pack-error'],
    ['{"resultRef":"branch:job-j","codex":"error"}', 0, 'codex-error'],
    ['', 1, 'runner-exit-nonzero'],
  ] as const)('releases an error result for retry instead of completing it (%s)', async (stdout, code, reason) => {
    const route = ports.call.getMockImplementation()!;
    let pulls = 0;
    ports.call.mockImplementation((...args) => {
      if (args[1] === 'release') return { demoted: false, result: { released: true } };
      if (args[1] === 'pull' && ++pulls > 1) return { demoted: false, result: { pulled: false } };
      return route(...args);
    });
    const { result } = await start();
    child.stdout.write(stdout); child.emit('close', code);
    expect(await result).toMatchObject({ pulled: false, previous: { jobId: 'j', completed: false, held: 'runner-error',
      reason, released: true, declined: false, failures: 1, pack: 'pack-1' } });
    const releases = ports.call.mock.calls.filter(c => c[1] === 'release');
    expect(releases).toHaveLength(1);
    expect(releases[0]![2]).toEqual(expect.arrayContaining(['--job', 'j', '--token', '4']));
    expect(releases[0]![2]).not.toContain('--decline');
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('declines a pack after two consecutive error results so another node takes it', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => args[1] === 'release' ? { demoted: false, result: { released: true } } : route(...args));
    const second = new Child();
    ports.spawn.mockReturnValueOnce(child).mockReturnValueOnce(second);
    const { result } = await start();
    child.stdout.write('{"resultRef":"branch:job-j","packError":"codex-exit-nonzero"}'); child.emit('close', 0);
    await vi.waitFor(() => expect(ports.spawn).toHaveBeenCalledTimes(2));
    second.stdout.write('{"codex":"error"}'); second.emit('close', 1);
    expect(await result).toMatchObject({ jobId: 'j', completed: false, held: 'runner-error', reason: 'codex-error',
      released: true, declined: true, failures: 2, previous: { declined: false, failures: 1 } });
    const releases = ports.call.mock.calls.filter(c => c[1] === 'release').map(c => c[2] as string[]);
    expect(releases.map(r => r.includes('--decline'))).toEqual([false, true]);
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('a success between failures resets the consecutive count', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => args[1] === 'release' ? { demoted: false, result: { released: true } } : route(...args));
    const second = new Child();
    ports.spawn.mockReturnValueOnce(child).mockReturnValueOnce(second);
    const { result } = await start();
    child.stdout.write('{"packError":"x"}'); child.emit('close', 0);
    await vi.waitFor(() => expect(ports.spawn).toHaveBeenCalledTimes(2));
    second.stdout.write('{"resultRef":"branch:job-j"}'); second.emit('close', 0);
    expect(await result).toMatchObject({ jobId: 'j', completed: true, previous: { reason: 'pack-error', declined: false } });
  });
  it('holds before acquiring a session when memory or disk is pressured', async () => {
    ports.capacity.mockReturnValue({ slots: 0, held: 'memory-pressure' });
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ held: 'memory-pressure' });
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.call).not.toHaveBeenCalled();
  });
  it('withholds spawn when pressure appears after a claim is acquired', async () => {
    const clear = { slots: 1, held: null };
    ports.capacity.mockReturnValueOnce(clear).mockReturnValueOnce(clear)
      .mockReturnValue({ slots: 0, held: 'memory-pressure' });
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ held: 'memory-pressure' });
    expect(ports.call.mock.calls.some(c => c[1] === 'pull')).toBe(true);
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('releases a pulled job it refuses so the claim is not stranded until expiry', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => {
      const reply = route(...args);
      if (args[1] === 'pull') reply.result.job = { id: 'j', requires: [], secrets: [] };
      if (args[1] === 'release') return { demoted: false, result: { released: true } };
      return reply;
    });
    expect(await runNodeWorker(config, '/reviewed/runner')).toEqual({ held: 'unsupported-job', released: true });
    const release = ports.call.mock.calls.find(c => c[1] === 'release')![2] as string[];
    expect(release).toEqual(expect.arrayContaining(['--job', 'j', '--token', '4', '--leader-token', '3', '--decline']));
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('releases a pack-capacity hold for retry: no decline, capacity payload kept, host slot freed', async () => {
    ports.capacity.mockImplementation((_light, options) => options?.pack
      ? { slots: 0, held: 'cpu-pressure' } : { slots: 1, held: null });
    ports.call.mockImplementation(((route) => (...args: unknown[]) => {
      if (args[1] === 'release') return { demoted: false, result: { released: true } };
      return (route as (...a: unknown[]) => unknown)(...args);
    })(ports.call.getMockImplementation()!));
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({
      held: 'cpu-pressure', released: true, capacity: { slots: 0, held: 'cpu-pressure' } });
    const release = ports.call.mock.calls.find(c => c[1] === 'release')![2] as string[];
    expect(release).toEqual(expect.arrayContaining(['--job', 'j', '--token', '4', '--leader-token', '3']));
    expect(release).not.toContain('--decline');
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledOnce();
  });
  it('releases a lease-lost claim before spawn without declining', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => {
      if (args[1] === 'release') return { demoted: false, result: { released: true } };
      const reply = route(...args);
      if (args[1] === 'renew') return { demoted: true, result: {} };
      return reply;
    });
    expect(await runNodeWorker(config, '/reviewed/runner')).toEqual({ held: 'lease-lost', released: true });
    const release = ports.call.mock.calls.find(c => c[1] === 'release')![2] as string[];
    expect(release).not.toContain('--decline');
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('a stopping node releases the claim without declining it', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => args[1] === 'release' ? { demoted: false, result: { released: true } } : route(...args));
    const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    ports.stat.mockImplementationOnce(enoent).mockImplementationOnce(enoent).mockImplementation(() => ({}));
    const out = await runNodeWorker(config, '/reviewed/runner');
    expect(out).toMatchObject({ held: 'unsupported-job', released: true });
    const release = ports.call.mock.calls.find(c => c[1] === 'release')![2] as string[];
    expect(release).not.toContain('--decline');
  });
  it('still refuses cleanly when the primary predates the release verb', async () => {
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => {
      if (args[1] === 'release') throw new Error('Invalid drive pool verb');
      const reply = route(...args);
      if (args[1] === 'pull') reply.result.job = { id: 'j', requires: [], secrets: [] };
      return reply;
    });
    expect(await runNodeWorker(config, '/reviewed/runner')).toEqual({ held: 'unsupported-job', released: false });
  });
  it('kills work on pressure before admitting another job', async () => {
    const { result } = await start();
    ports.capacity.mockReturnValue({ slots: 0, held: 'disk-pressure' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toMatchObject({ completed: false });
    expect(child.kill).toHaveBeenCalled();
    const args = ports.call.mock.calls.filter(c => c[1] === 'beat').at(-1)![2] as string[];
    expect(JSON.parse(args[args.indexOf('--capacity') + 1]!)).toMatchObject({ slots: 0, held: 'disk-pressure' });
    expect(ports.call.mock.calls.some(c => c[1] === 'complete')).toBe(false);
  });
  it('runs both Air slots under one session and leaves only after both finish', async () => {
    ports.capacity.mockReturnValue({ slots: 2, held: null });
    const route = ports.call.getMockImplementation()!;
    let pulls = 0;
    ports.call.mockImplementation((...args) => {
      const response = route(...args);
      if (args[1] === 'pull') {
        const id = `job-${++pulls}`;
        return { ...response, result: { ...response.result, job: { ...response.result.job, id },
          claim: { ...response.result.claim, jobId: id, token: 4 + pulls } } };
      }
      return response;
    });
    const second = new Child();
    ports.spawn.mockReturnValueOnce(child).mockReturnValueOnce(second);
    const { result } = await start();
    expect(ports.spawn).toHaveBeenCalledTimes(2);
    child.stdout.write('{"resultRef":"branch:first"}');
    child.emit('close', 0);
    await Promise.resolve();
    expect(ports.call.mock.calls.some(c => c[1] === 'leave')).toBe(false);
    second.stdout.write('{"resultRef":"branch:second"}');
    second.emit('close', 0);
    expect(await result).toMatchObject({ slots: 2, attempts: [{ completed: true }, { completed: true }] });
    expect(ports.call.mock.calls.filter(c => c[1] === 'join')).toHaveLength(1);
    expect(ports.call.mock.calls.filter(c => c[1] === 'leave')).toHaveLength(1);
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
  it('holds a losing host-slot contender before pulling or spawning', async () => {
    ports.acquire.mockReturnValue(null);
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ slots: 0, held: 'host-slots-exhausted' });
    expect(ports.call.mock.calls.some(c => c[1] === 'pull')).toBe(false);
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('preserves the full single-worker batch while free host slots decrease', async () => {
    let used = 0, advertised = 0, sampled = 0, claims = 0;
    ports.acquire.mockImplementation(() => { used++; return { release: () => { used--; } }; });
    ports.capacity.mockImplementation((_light, options) => ({ slots: 4 - used + (options?.lease ? 1 : 0), held: null }));
    const route = ports.call.getMockImplementation()!;
    ports.call.mockImplementation((...args) => {
      if (args[1] === 'beat') advertised = Number(args[2][args[2].indexOf('--slots') + 1]);
      // The pool overwrites --slots with the capacity sample, so both must carry the same number.
      if (args[1] === 'beat') sampled = JSON.parse(args[2][args[2].indexOf('--capacity') + 1]).slots;
      if (args[1] === 'pull' && claims++ >= advertised) return { result: { pulled: false } };
      return route(...args);
    });
    const children = Array.from({ length: 4 }, () => new Child());
    children.forEach(c => ports.spawn.mockReturnValueOnce(c));
    const { result } = await start();
    expect(ports.spawn).toHaveBeenCalledTimes(4);
    expect(used).toBe(4);
    await vi.advanceTimersByTimeAsync(3000);
    expect(advertised).toBe(4);
    expect(sampled).toBe(4);
    for (const c of children) { c.stdout.write('{"resultRef":"branch:done"}'); c.emit('close', 0); }
    expect(await result).toMatchObject({ slots: 4, attempts: Array.from({ length: 4 }, () => ({ completed: true })) });
    expect(used).toBe(0);
  });
  it('checks the claimed pack and releases its slot when CPU admission holds', async () => {
    ports.capacity.mockImplementation((_light, options) => options?.pack
      ? { slots: 0, held: 'cpu-pressure' } : { slots: 1, held: null });
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ held: 'cpu-pressure' });
    expect(ports.capacity).toHaveBeenCalledWith(false, expect.objectContaining({ pack: 'pack-1', lease: expect.any(Object) }));
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledOnce();
  });
  it('retains the host lease until the runner closes, including fencing', async () => {
    const { result } = await start();
    expect(ports.release).not.toHaveBeenCalled();
    ports.capacity.mockReturnValue({ slots: 0, held: 'host-slots-unmeasured' });
    child.kill.mockImplementation(() => true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
    // The pool's sample parser rejects host-slot holds, so this beat sends zero slots without a sample.
    const beat = ports.call.mock.calls.filter(c => c[1] === 'beat').at(-1)![2] as string[];
    expect(beat).not.toContain('--capacity');
    expect(beat[beat.indexOf('--slots') + 1]).toBe('0');
    child.emit('close', 1);
    await result;
    expect(ports.release).toHaveBeenCalledOnce();
  });
  it('releases a host slot on an empty pull or failed runner spawn', async () => {
    ports.spawn.mockImplementation(() => { throw new Error('spawn unavailable'); });
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ held: 'attempt-unavailable' });
    expect(ports.release).toHaveBeenCalledOnce();
    ports.release.mockClear();
    ports.call.mockImplementation((_config, verb) => ({ result: verb === 'join' ? { session: 2 } : {} }));
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ pulled: false });
    expect(ports.release).toHaveBeenCalledOnce();
  });
  it('holds an uncertain host registry before contacting a runner', async () => {
    ports.acquire.mockImplementation(() => { throw new Error('unsafe registry'); });
    expect(await runNodeWorker(config, '/reviewed/runner')).toMatchObject({ slots: 0, held: 'host-slots-unmeasured' });
    expect(ports.spawn).not.toHaveBeenCalled();
  });
});
