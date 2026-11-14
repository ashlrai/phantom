import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DriveNodes, type Pulled } from '../src/core/drive/nodes/index.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { runSessionPool, sessionPoolPolicy, type SessionPoolEvent, type SessionPoolPorts } from '../src/core/fleet/session-pool.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => vi.useRealTimers());
function fixture(count = 3) {
  const state = emptyState();
  const nodes = new DriveNodes({ transaction: fn => fn(state) });
  const session = nodes.join('worker', { owners: ['team'], caps: ['codex'], slots: 1 })!;
  for (let i = 0; i < count; i++) nodes.enqueue(`task-${i}`, { owner: 'team', requires: ['codex'] });
  const events: SessionPoolEvent[] = [], claims: Pulled[] = [];
  const run = vi.fn(async (task: Pulled) => { claims.push(task); return 'result'; });
  const close = vi.fn();
  const ports: SessionPoolPorts = {
    id: 'batch-1', now: Date.now, held: () => false,
    heartbeat: () => { if (!nodes.heartbeat(session)) throw new Error('expired'); },
    pull: () => nodes.pull(session), renew: claim => nodes.renewClaim(claim),
    complete: (claim, ref) => nodes.complete(claim, ref), leave: () => { nodes.leave(session); },
    open: vi.fn(() => ({ run, close })), emit: row => { events.push(row); },
  };
  return { nodes, session, state, ports, run, close, events, claims };
}
it('batches 100 tasks sequentially with unique fences, bounded contexts and paired attempt metrics', async () => {
  const f = fixture(101);
  expect(await runSessionPool(f.ports)).toEqual({ completed: 100, contexts: 4, reason: 'limit' });
  expect(f.ports.open).toHaveBeenCalledTimes(4);
  expect(f.close).toHaveBeenCalledTimes(4);
  expect(new Set(f.claims.map(t => t.claim.token)).size).toBe(100);
  expect(f.state.jobs[100]?.state).toBe('pending');
  const launch = f.events.filter(e => e.event === 'launch'), finish = f.events.filter(e => e.event === 'finish');
  expect(launch.map(e => e.job)).toEqual(finish.map(e => e.job));
  expect(new Set(launch.map(e => e.job)).size).toBe(100);
  expect(finish.every(e => e.outcome === 'completed')).toBe(true);
  expect(JSON.stringify(f.events)).not.toMatch(/token|resultRef|secrets/);
});
it('renews long tasks without prefetching and completes only once under the renewed fence', async () => {
  const f = fixture();
  let finish!: (ref: string) => void;
  f.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const result = runSessionPool(f.ports, { tasks: 1 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.state.jobs.map(j => j.state)).toEqual(['running', 'pending', 'pending']);
  expect(f.state.jobs[0]!.claim!.expiresAt).toBeGreaterThan(Date.now());
  finish('artifact');
  expect(await result).toMatchObject({ completed: 1, reason: 'limit' });
});
it('rotates contexts by age between tasks', async () => {
  const f = fixture();
  f.run.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return 'ref'; });
  const result = runSessionPool(f.ports, { rotateAfterMs: 5 });
  await vi.advanceTimersByTimeAsync(30);
  expect(await result).toEqual({ completed: 3, contexts: 3, reason: 'empty' });
});
it('requeues unfinished work after runner death and fences its late completion', async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error('died'));
  expect(await runSessionPool(f.ports)).toMatchObject({ completed: 0, reason: 'failed' });
  const old = f.state.jobs[0]!.claim!;
  await vi.advanceTimersByTimeAsync(30_000);
  const next = f.nodes.join('replacement', { owners: ['team'], caps: ['codex'], slots: 1 })!;
  f.nodes.heartbeat(next);
  const pulled = f.nodes.pull(next)!;
  expect(pulled.job.id).toBe('task-0');
  expect(pulled.claim.token).toBeGreaterThan(old.token);
  expect(f.nodes.complete(old, 'late')).toBe(false);
  expect(f.nodes.complete(pulled.claim, 'new')).toBe(true);
  expect(f.events.find(e => e.event === 'finish')?.outcome).toBe('lease-expiry');
});
it('recovers even when session cleanup never reaches the authority', async () => {
  const f = fixture(1);
  f.run.mockRejectedValue(new Error('dead'));
  f.ports.leave = () => { throw new Error('disconnected'); };
  await runSessionPool(f.ports);
  await vi.advanceTimersByTimeAsync(30_000);
  const replacement = f.nodes.join('worker', { owners: ['team'], caps: ['codex'] })!;
  f.nodes.heartbeat(replacement);
  expect(f.nodes.pull(replacement)?.job.id).toBe('task-0');
});
it.each(['abort', 'timeout', 'lease', 'held'] as const)('terminates an uncooperative executor on %s', async kind => {
  const f = fixture();
  const controller = new AbortController();
  f.run.mockImplementation(() => new Promise(() => {}));
  const result = runSessionPool(f.ports, { taskTimeoutMs: kind === 'timeout' ? 100 : 6000 }, controller.signal);
  await vi.advanceTimersByTimeAsync(1);
  if (kind === 'abort') controller.abort();
  if (kind === 'lease') f.ports.renew = () => null;
  if (kind === 'held') f.ports.held = () => true;
  await vi.advanceTimersByTimeAsync(kind === 'timeout' || kind === 'abort' ? 100 : 3000);
  expect(await result).toMatchObject({ completed: 0, reason: kind === 'abort' ? 'aborted' : 'failed' });
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.state.jobs[1]!.state).toBe('pending');
  expect(vi.getTimerCount()).toBe(0);
});
it('refuses a result when the leader epoch changed before completion', async () => {
  const f = fixture();
  f.run.mockImplementation(async () => { f.state.leader!.token++; return 'late'; });
  expect(await runSessionPool(f.ports)).toMatchObject({ completed: 0, reason: 'failed' });
  expect(f.state.jobs[0]?.state).toBe('running');
});
it('stops on telemetry failure without undoing a durable completion', async () => {
  const f = fixture();
  f.ports.emit = e => { if (e.event === 'finish') throw new Error('disk'); };
  expect(await runSessionPool(f.ports)).toMatchObject({ completed: 1, reason: 'failed' });
  expect(f.state.jobs.map(j => j.state)).toEqual(['completed', 'pending', 'pending']);
});
it('does not open a context for an empty, stopped or held pool', async () => {
  for (const kind of ['empty', 'held', 'aborted']) {
    const f = fixture(kind === 'empty' ? 0 : 1);
    const controller = new AbortController();
    if (kind === 'held') f.ports.held = () => true;
    if (kind === 'aborted') controller.abort();
    expect(await runSessionPool(f.ports, {}, controller.signal)).toMatchObject({ reason: kind, contexts: 0 });
    expect(f.ports.open).not.toHaveBeenCalled();
  }
});
it('validates bounds before acquiring work', () => {
  for (const policy of [{ tasks: 101 }, { tasks: 0 }, { tasks: NaN }, { rotateAfterTasks: 1.1 }, { renewEveryMs: 3001 }]) {
    expect(() => sessionPoolPolicy(policy)).toThrow('Invalid session pool policy');
  }
});
