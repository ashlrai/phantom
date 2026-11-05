import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ read: vi.fn(), configure: vi.fn(), call: vi.fn(), capacity: vi.fn() }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ readPoolConfig: deps.read, configurePool: deps.configure, callPool: deps.call }));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ probeNodeLanes: () => ['codex'] }));
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
