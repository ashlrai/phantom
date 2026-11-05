import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalNodesStore } from '../src/core/drive/nodes/local-store.js';
import { describe, expect, it, vi } from 'vitest';
import { emptyState, parseState, type NodesState, type NodesStore } from '../src/core/drive/nodes/state.js';
import { executePool, initializePool, PRIMARY_TIMEOUT_MS, type PoolRole } from '../src/core/drive/nodes/pool.js';
import { callPool, configurePool, serveNodeRpc, type NodeRpcRequest, type PoolConfig } from '../src/core/drive/nodes/pool-host.js';
import { callNodeSsh, sshApprovalStep, validSshHost } from '../src/core/drive/nodes/ssh.js';
import { probeNodeLanes } from '../src/core/drive/nodes/worker.js';
import type { spawnSync } from 'node:child_process';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    parseState(draft);
    this.state = draft;
    return structuredClone(result);
  }
}
function fixture() {
  const store = new MemoryStore();
  let now = 1000;
  initializePool(store, 'main-mac', 'backup-mac', now);
  return { store, advance: (ms: number) => { now += ms; },
    beat: (origin: PoolRole) => executePool(store, { origin, action: 'heartbeat' }, 'mason', now),
    run: (origin: PoolRole, verb: string, args: string[] = []) => executePool(store, { origin, action: 'execute', verb, args }, 'mason', now) };
}
const worker: PoolConfig = { role: 'worker', node: 'worker', owner: 'mason', primary: 'main-mac', backup: 'backup-mac' };

describe('multi-Mac durable fencing witness', () => {
  it('holds backup admission until exactly fifteen minutes without a primary heartbeat', () => {
    const f = fixture();
    f.advance(PRIMARY_TIMEOUT_MS - 1);
    expect(f.run('backup', 'join', ['--node', 'secondary']).demoted).toBe(true);
    expect(f.store.state.nodes).toHaveLength(0);
    f.advance(1);
    const promoted = f.run('backup', 'join', ['--node', 'secondary']);
    expect(promoted).toMatchObject({ active: 'backup', demoted: false, epoch: 2 });
    expect(f.store.state.nodes).toHaveLength(1);
  });
  it('renews the primary heartbeat without changing its epoch', () => {
    const f = fixture();
    f.advance(PRIMARY_TIMEOUT_MS - 1);
    expect(f.beat('primary')).toMatchObject({ active: 'primary', epoch: 1 });
    f.advance(PRIMARY_TIMEOUT_MS - 1);
    expect(f.beat('backup')).toMatchObject({ active: 'primary', demoted: true });
  });
  it('serializes racing primary return and backup promotion to one runner', () => {
    for (const order of [['primary', 'backup'], ['backup', 'primary']] as const) {
      const f = fixture();
      f.advance(PRIMARY_TIMEOUT_MS);
      const [a, b] = order.map(role => f.beat(role));
      expect(a!.active).toBe('backup');
      expect(b!.active).toBe('backup');
      expect(f.run('primary', 'enqueue', ['--job', 'late']).demoted).toBe(true);
      expect(f.run('backup', 'enqueue', ['--job', 'new']).result).toMatchObject({ enqueued: true });
      expect(f.store.state.jobs.map(j => j.id)).toEqual(['new']);
    }
  });
  it('fences pre-promotion claims and refuses primary resurrection on return', () => {
    const f = fixture();
    const s = f.run('primary', 'join', ['--node', 'worker', '--caps', 'codex']).result['session'];
    f.run('primary', 'enqueue', ['--job', 'j', '--requires', 'codex']);
    const old = f.run('primary', 'pull', ['--node', 'worker', '--session', String(s)]).result['claim'] as
      { token: number; leaderToken: number };
    f.store.state.nodes[0]!.expiresAt = 2 * PRIMARY_TIMEOUT_MS;
    f.store.state.jobs[0]!.claim!.expiresAt = 2 * PRIMARY_TIMEOUT_MS;
    f.store.state.leader!.expiresAt = 2 * PRIMARY_TIMEOUT_MS;
    f.advance(PRIMARY_TIMEOUT_MS);
    f.beat('backup');
    const staleLive = ['--node', 'worker', '--session', String(s), '--job', 'j', '--token', String(old.token), '--leader-token', String(old.leaderToken)];
    expect(() => f.run('backup', 'renew', staleLive)).toThrow(/lease is gone/);
    // Expire the synthetic long session before the new worker rejoins.
    f.store.state.nodes[0]!.expiresAt = 0;
    f.store.state.jobs[0]!.claim!.expiresAt = 0;
    const next = f.run('backup', 'join', ['--node', 'worker', '--caps', 'codex']).result['session'];
    const fresh = f.run('backup', 'pull', ['--node', 'worker', '--session', String(next)]).result['claim'] as typeof old;
    expect(fresh.token).toBeGreaterThan(old.token);
    const stale = ['--node', 'worker', '--session', String(s), '--job', 'j', '--token', String(old.token), '--leader-token', String(old.leaderToken)];
    expect(() => f.run('backup', 'complete', stale)).toThrow(/Completion refused/);
    expect(f.beat('primary')).toMatchObject({ active: 'backup', demoted: true });
    expect(f.store.state.jobs[0]!.state).toBe('running');
  });
  it('never admits at both origins while requests alternate across a partition', () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) {
      f.advance(30_000);
      const p = f.run('primary', 'enqueue', ['--job', `p${i}`]);
      const b = f.run('backup', 'enqueue', ['--job', `b${i}`]);
      expect(Number(!p.demoted) + Number(!b.demoted)).toBe(1);
    }
  });
  it('rejects clock regression, malformed state and witness reinitialization', () => {
    const f = fixture();
    f.advance(-1);
    expect(() => f.beat('primary')).toThrow(/clock/);
    expect(() => initializePool(f.store, 'main-mac', 'backup-mac', 1000)).toThrow(/fresh/);
    expect(() => parseState({ ...f.store.state, pool: { ...f.store.state.pool, epoch: 0 } })).toThrow();
  });
  it('keeps jobs in the configured owner scope and exposes lanes, load and heartbeat', () => {
    const f = fixture();
    f.run('primary', 'join', ['--node', 'worker', '--caps', 'codex']);
    expect(() => f.run('primary', 'enqueue', ['--job', 'foreign', '--owner=other'])).toThrow(/owner/);
    expect(f.run('primary', 'status').result['nodes']).toEqual([expect.objectContaining({ lanes: ['codex'], usage: 0, heartbeatAt: 1000 })]);
    expect(f.run('primary', 'list').result).toEqual(f.run('primary', 'status').result);
  });
});

describe('SSH routing and device-local provider lanes', () => {
  it('fails over to the backup endpoint when primary is unavailable', () => {
    const ssh = vi.fn((host: string) => {
      if (host === 'main-mac') throw new Error('partition');
      return { schemaVersion: 1, active: 'backup', epoch: 2, demoted: false, result: { nodes: [] } };
    });
    expect(callPool(worker, 'list', [], ssh)).toMatchObject({ active: 'backup' });
    expect(ssh.mock.calls.map(c => c[0])).toEqual(['main-mac', 'backup-mac']);
  });
  it('never permits the primary to bypass an unavailable witness', () => {
    const ssh = vi.fn(() => { throw new Error('witness offline'); });
    expect(() => callPool({ ...worker, role: 'primary' }, 'pull', [], ssh)).toThrow(/admission is closed/);
    expect(ssh.mock.calls).toHaveLength(1);
  });
  it('fails closed when both SSH routes are unavailable', () => {
    expect(() => callPool(worker, 'pull', [], () => { throw new Error('offline'); })).toThrow();
  });
  it('uses a fixed SSH command, stdin payload and no forwarded agent or ambient credentials', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '{"ok":true}' })) as unknown as typeof spawnSync;
    expect(callNodeSsh('main-mac', { job: 'synthetic' }, run)).toEqual({ ok: true });
    const [command, args, options] = vi.mocked(run).mock.calls[0]!;
    expect(command).toBe('ssh');
    expect(args).toContain('ForwardAgent=no');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('phm node rpc --json');
    expect(options).toMatchObject({ input: '{"job":"synthetic"}' });
    expect(Object.keys((options as { env: object }).env).sort()).toEqual(['HOME', 'PATH']);
  });
  it('rejects shell injection and never relays SSH diagnostics', () => {
    for (const host of ['-oProxyCommand=x', 'mac;id', 'user@host', '$(id)', 'host\ncmd']) {
      expect(validSshHost(host)).toBe(false);
      expect(() => callNodeSsh(host, {})).toThrow();
    }
    const run = (() => ({ status: 1, stderr: 'synthetic-private-diagnostic' })) as unknown as typeof spawnSync;
    expect(() => callNodeSsh('main-mac', {}, run)).toThrow('Node SSH unavailable');
    expect(sshApprovalStep('main-mac')).toContain('StrictHostKeyChecking=ask main-mac true');
  });
  it('advertises only provider CLIs signed in on this device without reading their output', () => {
    const run = vi.fn((command: string) => ({ status: command === 'codex' ? 0 : 1 })) as unknown as typeof spawnSync;
    expect(probeNodeLanes(run)).toEqual(['codex']);
    for (const call of vi.mocked(run).mock.calls) expect(call[2]).toMatchObject({ stdio: 'ignore', timeout: 5000 });
  });
});


describe('durable SSH pool round trip', () => {
  it('mirrors primary transitions, survives witness restart and demotes a returned primary', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'multinode-roundtrip-'));
    const primaryRoot = join(directory, 'primary'), backupRoot = join(directory, 'backup');
    mkdirSync(primaryRoot, { mode: 0o700 }); mkdirSync(backupRoot, { mode: 0o700 });
    const previous = process.env['ASHLR_HOME'];
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const primary: PoolConfig = { ...worker, role: 'primary' };
    const backup: PoolConfig = { ...worker, role: 'backup' };
    const at = <T>(root: string, action: () => T): T => {
      const before = process.env['ASHLR_HOME'];
      process.env['ASHLR_HOME'] = root;
      try { return action(); } finally {
        if (before === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = before;
      }
    };
    try {
      at(backupRoot, () => configurePool(backup));
      at(primaryRoot, () => configurePool(primary));
      const ssh = (_host: string, request: unknown) => at(backupRoot, () => serveNodeRpc(backup, request as NodeRpcRequest));
      const run = (verb: string, args: string[]) => at(primaryRoot, () => callPool(primary, verb, args, ssh));
      const session = run('join', ['--node', 'worker', '--caps', 'codex']).result['session'];
      run('enqueue', ['--job', 'disk-job', '--requires', 'codex']);
      expect(run('pull', ['--node', 'worker', '--session', String(session)]).result['pulled']).toBe(true);
      const mirror = JSON.parse(readFileSync(join(primaryRoot, 'node-pool', 'primary-mirror.json'), 'utf8')) as NodesState;
      expect(mirror.jobs[0]?.state).toBe('running');
      now += PRIMARY_TIMEOUT_MS;
      at(backupRoot, () => serveNodeRpc(backup, { kind: 'client', request: { action: 'heartbeat', origin: 'backup' } }));
      // Reopening the durable witness cannot restore primary authority.
      const reopened = new LocalNodesStore(join(backupRoot, 'node-pool'));
      expect(reopened.transaction(state => state.pool?.active)).toBe('backup');
      expect(run('enqueue', ['--job', 'stale-primary'])).toMatchObject({ active: 'backup', demoted: true });
      expect(reopened.transaction(state => state.jobs.map(j => j.id))).toEqual(['disk-job']);
    } finally {
      clock.mockRestore();
      if (previous === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
