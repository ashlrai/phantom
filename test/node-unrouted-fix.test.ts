/**
 * planRoutes' unrouted-job fix names every blocker kind the owner scope
 * actually hits. The first-blocker cascade could prescribe a remedy that
 * cannot unblock — "no node advertises gh" while a node advertises gh but
 * lacks local auth, or "wait for a free slot" while another node idles
 * missing one cap. A single blocker kind keeps the original sentence; mixed
 * kinds get an honest per-kind list with each applicable fix.
 */
import { describe, expect, it } from 'vitest';
import { DriveNodes } from '../src/core/drive/nodes/index.js';
import { emptyState, parseState, type NodesState, type NodesStore } from '../src/core/drive/nodes/state.js';

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
const fixOf = (nodes: DriveNodes, jobId: string): string | undefined =>
  nodes.plan().find(r => r.jobId === jobId)?.fix;

describe('unrouted-job fix names the full blocker set', () => {
  it('names caps and auth together when different nodes fail different fences', () => {
    const { nodes } = fixture();
    // ghnode advertises gh but never probed auth (unknown is not ok);
    // buildnode probed auth ok but does not advertise gh.
    nodes.join('ghnode', { owners: ['acme'], caps: ['gh'] });
    const buildnode = nodes.join('buildnode', { owners: ['acme'], caps: ['build'] })!;
    nodes.heartbeat(buildnode, { auth: 'ok' });
    nodes.enqueue('j1', { owner: 'acme', requires: ['gh'] });
    // The old caps-only fix would have sent the operator to rejoin with
    // --caps gh — which still could not route, since ghnode's auth is unknown.
    expect(fixOf(nodes, 'j1')).toBe(
      "No node owned by 'acme' can take it now: missing required caps (gh) on some nodes; missing local gh auth on some nodes. Rejoin a node with --caps including them. Run 'gh auth login' on one, then: phm node beat --probe-auth");
  });

  it('names a free-slot wait and a cap gap when one node is full and another lacks the cap', () => {
    const { nodes } = fixture();
    const full = nodes.join('full', { owners: ['mason'], caps: ['build'], slots: 1 })!;
    nodes.join('idle', { owners: ['mason'] });
    nodes.enqueue('fill', { owner: 'mason' });
    expect(nodes.pull(full)?.job.id).toBe('fill');
    nodes.enqueue('needbuild', { owner: 'mason', requires: ['build'] });
    // "wait for a free slot" alone would have hidden that idle cannot run it.
    expect(fixOf(nodes, 'needbuild')).toBe(
      "No node owned by 'mason' can take it now: missing required caps (build) on some nodes; no free job slots on some nodes. Rejoin a node with --caps including them. Wait for work to finish or memory headroom to recover.");
  });

  it('names a decline and a cap gap when the only capable node released the job unrun', () => {
    const { nodes } = fixture();
    const decliner = nodes.join('decliner', { owners: ['acme'], caps: ['build'] })!;
    nodes.join('bare', { owners: ['acme'] });
    nodes.enqueue('j1', { owner: 'acme', requires: ['build'] });
    const pulled = nodes.pull(decliner)!;
    expect(pulled.job.id).toBe('j1');
    nodes.release(pulled.claim, true);
    // "No node advertises build" would have been false: decliner does.
    expect(fixOf(nodes, 'j1')).toBe(
      "No node owned by 'acme' can take it now: missing required caps (build) on some nodes; released unrun by some sessions. Rejoin a node with --caps including them. Re-enqueue it with --requires naming a lane a node advertises.");
  });

  it('keeps the original auth sentence when auth is the only blocker', () => {
    const { nodes } = fixture();
    nodes.join('ghnode', { owners: ['acme'], caps: ['gh'] });
    nodes.enqueue('j1', { owner: 'acme', requires: ['gh'] });
    expect(fixOf(nodes, 'j1')).toBe(
      "Nodes owned by 'acme' lack local gh auth. Run 'gh auth login' on one, then: phm node beat --probe-auth");
  });

  it('keeps the original slot sentence when capacity is the only blocker', () => {
    const { nodes } = fixture();
    nodes.join('held', { owners: ['acme'], slots: 0 });
    nodes.enqueue('j1', { owner: 'acme' });
    expect(fixOf(nodes, 'j1')).toBe(
      "Nodes owned by 'acme' have no free job slots. Wait for work to finish or memory headroom to recover.");
  });

  it('keeps the original decline sentence when it is the only blocker', () => {
    const { nodes } = fixture();
    const worker = nodes.join('solo', { owners: ['acme'], caps: ['build'] })!;
    nodes.enqueue('j1', { owner: 'acme', requires: ['build'] });
    const pulled = nodes.pull(worker)!;
    nodes.release(pulled.claim, true);
    expect(fixOf(nodes, 'j1')).toBe(
      "Every eligible node released 'j1' unrun (it cannot execute the job). Re-enqueue it with --requires naming a lane a node advertises.");
  });
});
