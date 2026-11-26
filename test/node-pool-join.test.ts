import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // cmdNodeFleet delegates to the pool only when a config file exists; the
    // mocked readPoolConfig supplies its contents, so any valid file marks it configured.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'node-pool-home-')));
    vi.stubEnv('ASHLR_HOME', home);
    try {
      mkdirSync(join(home, 'node-pool'), { recursive: true });
      writeFileSync(join(home, 'node-pool', 'config.json'), JSON.stringify(config));
      expect(await cmdNode(['join', '--json'])).toBe(0);
      expect(deps.configure).not.toHaveBeenCalled();
      expect(deps.call).toHaveBeenCalledWith(config, 'join', ['--node', 'air', '--caps', 'codex', '--slots', '2']);
      expect(deps.call).toHaveBeenCalledWith(config, 'leave', ['--node', 'air', '--session', '3']);
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
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
    expect(await cmdNodePool('join', ['--owner', 'other', '--json'])).toBe(2);
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('derives node identity on first enrollment after proving the route', async () => {
    deps.read.mockReturnValue(null);
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(0);
    expect(deps.configure).toHaveBeenCalledWith(expect.objectContaining({ role: 'worker', node: expect.stringMatching(/^[a-zA-Z0-9_.-]+$/) }));
  });
  it('rejects incomplete identity and ignored role flags before contacting SSH', async () => {
    deps.read.mockReturnValue(null);
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--json'])).toBe(2);
    expect(await cmdNodePool('join', ['--role', 'primary', '--json'])).toBe(2);
    expect(deps.call).not.toHaveBeenCalled();
  });
  it('never configures a failed registration', async () => {
    deps.read.mockReturnValue(null);
    deps.call.mockImplementation(() => { throw new Error('offline'); });
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(1);
    expect(deps.configure).not.toHaveBeenCalled();
    const out = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(out).toMatchObject({ registered: false, approvalSteps: [expect.stringContaining('ssh-copy-id primary-mac'), expect.stringContaining('ssh-copy-id backup-mac')] });
    expect(out.approvalSteps[0]).toContain('phm on the SSH PATH');
  });
  it('refuses repeat join while this node id holds a live pool session', async () => {
    deps.call.mockImplementation((_config, verb) => verb === 'status'
      ? { demoted: false, result: { nodes: [{ nodeId: 'air', live: true }, { nodeId: 'other', live: true }] } }
      : { demoted: false, result: { session: 3 } });
    expect(await cmdNodePool('join', ['--json'])).toBe(1);
    expect(deps.call.mock.calls.some(c => c[1] === 'join')).toBe(false);
    const out = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(out).toMatchObject({ command: 'join', registered: false, error: { code: 'node-live' } });
    expect(out.error.fix).toContain('phm node status --json');
  });
  it('joins when only a different node id holds a live session', async () => {
    deps.call.mockImplementation((_config, verb) => verb === 'status'
      ? { demoted: false, result: { nodes: [{ nodeId: 'other', live: true }] } }
      : { demoted: false, result: verb === 'join' ? { session: 3 } : { left: true } });
    expect(await cmdNodePool('join', ['--json'])).toBe(0);
    expect(deps.call).toHaveBeenCalledWith(config, 'join', ['--node', 'air', '--caps', 'codex', '--slots', '2']);
  });
  it('falls through to the join attempt when the status pre-check cannot reach the pool', async () => {
    deps.call.mockImplementation((_config, verb) => {
      if (verb === 'status') throw new Error('offline');
      return { demoted: false, result: verb === 'join' ? { session: 3 } : { left: true } };
    });
    expect(await cmdNodePool('join', ['--json'])).toBe(0);
    expect(deps.call).toHaveBeenCalledWith(config, 'join', ['--node', 'air', '--caps', 'codex', '--slots', '2']);
  });
  it('reports a held registration without approval steps when the pool answers without a session', async () => {
    deps.read.mockReturnValue(null);
    deps.call.mockImplementation((_config, verb) => verb === 'status'
      ? { demoted: false, result: { nodes: [] } }
      : { demoted: false, result: {} });
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(1);
    const out = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(out).toMatchObject({ registered: false, error: { code: 'held' } });
    expect(out.approvalSteps).toBeUndefined();
    expect(deps.configure).not.toHaveBeenCalled();
  });
  it('still enrolls when releasing the probe session fails, and says so', async () => {
    deps.call.mockImplementation((_config, verb) => {
      if (verb === 'leave') throw new Error('offline');
      return { demoted: false, result: verb === 'join' ? { session: 3 } : { nodes: [] } };
    });
    expect(await cmdNodePool('join', ['--json'])).toBe(0);
    const out = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(out).toMatchObject({ registered: true, session: 3 });
    expect(out.note).toContain('expires within about 30 seconds');
  });
  it('reports a local config write failure after remote registration succeeded', async () => {
    deps.read.mockReturnValue(null);
    deps.configure.mockImplementation(() => { throw new Error('EACCES'); });
    expect(await cmdNodePool('join', ['--primary', 'primary-mac', '--backup', 'backup-mac', '--owner', 'mason', '--json'])).toBe(1);
    const out = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(out).toMatchObject({ registered: true, configured: false, error: { code: 'error' } });
  });
});
