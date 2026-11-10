import { describe, expect, it } from 'vitest';
import { DriveNodes } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
import { emptyState, parseState, type NodesState, type NodesStore } from '../src/core/drive/nodes/state.js';
import { planRoutes } from '../src/core/drive/nodes/router.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = parseState(draft);
    return structuredClone(result);
  }
}
function fixture() {
  const store = new MemoryStore();
  const nodes = new DriveNodes(store, { now: () => 1000 });
  return { nodes, store };
}

describe('node slot admission', () => {
  it('admits only nodes with a known heartbeat less than five minutes old, even with long leases', () => {
    const store = new MemoryStore();
    let now = 1_000;
    const nodes = new DriveNodes(store, { now: () => now, nodeTtlMs: 1_000_000, leaderTtlMs: 1_000_000 });
    const worker = nodes.join('worker', { owners: ['mason'] })!;
    const leader = nodes.heartbeat(worker)!.leader!;
    nodes.enqueue('job', { owner: 'mason' });
    now += 299_999;
    expect(nodes.plan()[0]?.nodeId).toBe('worker');
    now++;
    expect(nodes.plan()[0]?.nodeId).toBeNull();
    expect(nodes.pull(worker)).toBeNull();
    expect(nodes.claim(leader, worker, 'job')).toBeNull();
    store.state.nodes[0]!.heartbeatAt = 0;
    expect(planRoutes(store.state, now)[0]?.nodeId).toBeNull();
    store.state.nodes[0]!.heartbeatAt = now + 1;
    expect(planRoutes(store.state, now)[0]?.nodeId).toBeNull();
  });
  it('bounds planned and held claims across heterogeneous Macs', () => {
    const { nodes } = fixture();
    const air = nodes.join('air16', { owners: ['mason'], slots: 2 })!;
    const pro = nodes.join('pro8', { owners: ['mason'], slots: 1 })!;
    for (let i = 0; i < 5; i++) nodes.enqueue(`job${i}`, { owner: 'mason' });
    expect(nodes.plan().map(a => a.nodeId)).toEqual(['air16', 'pro8', 'air16', null, null]);
    expect(nodes.pull(air)).not.toBeNull();
    expect(nodes.pull(pro)).not.toBeNull();
    expect(nodes.pull(air)).not.toBeNull();
    expect(nodes.pull(air)).toBeNull();
    expect(nodes.pull(pro)).toBeNull();
    expect(nodes.plan()[0]?.fix).toContain('no free job slots');
  });

  it('holds immediately at zero slots and resumes from a fresh heartbeat', () => {
    const { nodes } = fixture();
    const session = nodes.join('air', { owners: ['mason'], slots: 2 })!;
    nodes.enqueue('job', { owner: 'mason' });
    nodes.heartbeat(session, { slots: 0 });
    expect(nodes.pull(session)).toBeNull();
    expect(nodes.view(['mason']).nodes[0]?.slots).toBe(0);
    nodes.heartbeat(session, { slots: 1 });
    expect(nodes.pull(session)?.job.id).toBe('job');
  });

  it('also enforces slots on the direct queue claim API', () => {
    const { nodes } = fixture();
    const session = nodes.join('pro', { owners: ['mason'], slots: 0 })!;
    const leader = nodes.heartbeat(session)!.leader!;
    nodes.enqueue('job', { owner: 'mason' });
    expect(nodes.claim(leader, session, 'job')).toBeNull();
  });

  it('keeps existing records without slots compatible', () => {
    const { nodes } = fixture();
    nodes.join('legacy', { owners: ['mason'] });
    for (let i = 0; i < 70; i++) nodes.enqueue(`job${i}`, { owner: 'mason' });
    expect(nodes.plan().every(r => r.nodeId === 'legacy')).toBe(true);
  });

  it.each([-1, 65, 1.5, NaN, Infinity])('refuses invalid slot count %s before changing state', slots => {
    const { nodes, store } = fixture();
    expect(() => nodes.join('bad', { owners: ['mason'], slots })).toThrow(/slots/);
    expect(store.state.nodes).toHaveLength(0);
    const session = nodes.join('good', { owners: ['mason'], slots: 1 })!;
    expect(() => nodes.heartbeat(session, { slots })).toThrow(/slots/);
    expect(store.state.nodes[0]?.slots).toBe(1);
    const bad = structuredClone(store.state);
    bad.nodes[0]!.slots = slots;
    expect(() => parseState(bad)).toThrow();
  });

  it('accepts slot reports through the existing strict node command parser', () => {
    const { nodes } = fixture();
    const joined = executeNodeFleet('join', ['--node', 'pro', '--owner', 'mason', '--slots', '1'], nodes);
    executeNodeFleet('beat', ['--node', 'pro', '--session', String(joined['session']), '--slots', '0'], nodes);
    expect(nodes.view(['mason']).nodes[0]?.slots).toBe(0);
    expect(() => executeNodeFleet('join', ['--node', 'bad', '--owner', 'mason', '--slots', '65'], nodes)).toThrow();
  });
});
