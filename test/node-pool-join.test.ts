import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const deps = vi.hoisted(() => ({ read: vi.fn(), configure: vi.fn(), call: vi.fn(), capacity: vi.fn(), worker: vi.fn() }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ readPoolConfig: deps.read, configurePool: deps.configure, callPool: deps.call }));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ probeNodeLanes: () => ['codex'], runNodeWorker: deps.worker }));
vi.mock('../src/core/drive/nodes/capacity.js', () => ({ readNodeCapacity: deps.capacity }));
import { cmdNode } from '../src/cli/node.js';
import { cmdNodePool } from '../src/cli/node-pool.js';
const config = { role: 'worker', node: 'air', owner: 'mason', primary: 'primary-mac', backup: 'backup-mac' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  deps.read.mockReturnValue(config);
  deps.capacity.mockReturnValue({ slots: 2, held: null });
  deps.call.mockImplementation((_config, verb) => ({ demoted: false, result: verb === 'join' ? { session: 3 } : { left: true } }));
});
describe('repeatable Mac enrollment', () => {
  it('includes local host slot exhaustion in pool status', async () => {
    deps.capacity.mockReturnValue({ slots: 0, held: 'host-slots-exhausted' });
    expect(await cmdNodePool('status', ['--json'])).toBe(0);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({ capacity: { slots: 0, held: 'host-slots-exhausted' } });
  });
  it('writes a private metrics snapshot beneath an existing shared metrics directory', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'muse-metrics-')));
    vi.stubEnv('HOME', home);
    try {
      mkdirSync(join(home, '.ashlr-runs', 'metrics'), { recursive: true, mode: 0o755 });
      deps.read.mockReturnValue({ ...config, owner: 'ashlr' });
      deps.call.mockReturnValue({ demoted: false, result: { nodes: [], jobs: [] } });
      expect(await cmdNode(['light', 'restock', '--apply', '--json'])).toBe(0);
      const file = join(home, '.ashlr-runs', 'metrics', 'muse-light', 'status.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 'muse.light.v1', museCompleted: 0 });
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
  });
  it('passes the opt-in light profile to the host-owned worker', async () => {
    deps.worker.mockResolvedValue({ slots: 2, attempts: [] });
    expect(await cmdNodePool('worker', ['--runner', '/reviewed/light-runner', '--light', '--json'])).toBe(0);
    expect(deps.worker).toHaveBeenCalledWith(config, '/reviewed/light-runner', true);
  });
  it('routes light previews through the configured pool without enqueue', async () => {
    deps.read.mockReturnValue({ ...config, owner: 'ashlr' });
    deps.call.mockReturnValue({ demoted: false, result: { nodes: [], jobs: [] } });
    expect(await cmdNode(['light', 'restock', '--json'])).toBe(0);
    expect(deps.call).toHaveBeenCalledWith(expect.objectContaining({ owner: 'ashlr' }), 'status', ['--owner', 'ashlr']);
    expect(deps.call).toHaveBeenCalledTimes(1);
    deps.call.mockClear();
    expect(await cmdNode(['light', 'status', '--apply', '--json'])).toBe(1);
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('routes zero-argument join through the pool and preserves stored identity', async () => {
    expect(await cmdNode(['join', '--json'])).toBe(0);
    expect(deps.configure).not.toHaveBeenCalled();
    expect(deps.call).toHaveBeenCalledWith(config, 'join', ['--node', 'air', '--caps', 'codex', '--slots', '2']);
    expect(deps.call).toHaveBeenCalledWith(config, 'leave', ['--node', 'air', '--session', '3']);
  });
  it('retains explicit live-session join for existing router clients', async () => {
    const args = ['--node', 'air', '--owner', 'mason', '--caps', 'codex', '--slots', '2', '--json'];
    expect(await cmdNodePool('join', args)).toBe(0);
    expect(deps.call).toHaveBeenCalledWith(config, 'join', args);
    expect(deps.call.mock.calls.some(c => c[1] === 'leave')).toBe(false);
  });
  it('preserves a backup role and never resets its witness', async () => {
    deps.read.mockReturnValue({ ...config, role: 'backup' });
    expect(await cmdNodePool('join', ['--json'])).toBe(0);
    expect(deps.configure).not.toHaveBeenCalled();
  });
  it('rejects attempts to silently switch pool identity', async () => {
    expect(await cmdNodePool('join', ['--owner', 'other', '--json'])).toBe(1);
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('derives node identity on first enrollment after proving the route', async () => {
    deps.read.mockReturnValue(null);
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(0);
    expect(deps.configure).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker', node: expect.stringMatching(/^[a-zA-Z0-9_.-]+$/) }));
  });
  it('rejects incomplete identity and ignored role flags before contacting SSH', async () => {
    deps.read.mockReturnValue(null);
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--json'])).toBe(1);
    expect(await cmdNodePool('join', ['--role', 'primary', '--json'])).toBe(1);
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('never configures a failed registration', async () => {
    deps.read.mockReturnValue(null);
    deps.call.mockImplementation(() => { throw new Error('offline'); });
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(1);
    expect(deps.configure).not.toHaveBeenCalled();
  });
});
