import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNodesPlan, type NodesPlan } from '../src/core/fleet/nodes-plan.js';
import { readNodesView, type NodesViewDeps } from '../src/core/fleet/nodes-view.js';
import { dispatchNodeJob, planOnlyAdapter, type NodeDispatchAdapter, type NodeProbe } from '../src/core/fleet/nodes-dispatch.js';
import type { QueueOrderV1 } from '../src/core/queue/order-types.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const view: NodesViewDeps = {
  peers: { now: () => new Date(now), homeDir: () => '/fake', exec: () => JSON.stringify({ BackendState: 'Running', Self: { HostName: 'local-fake' }, Peer: { x: { HostName: 'remote-fake', OS: 'macOS', Online: true } } }) },
  readRegistry: () => ({ source: 'pool-witness', selfNode: 'local-fake', state: { version: 'drive.nodes.v1', sequence: 1, observedAt: now, leader: null, jobs: [], nodes: [{ nodeId: 'remote-fake', session: 1, heartbeatAt: now, expiresAt: now + 30000, caps: ['codex'], slots: 1 }] } }),
  localStats: () => { throw new Error('no sample'); }, hostName: () => 'local-fake', timeZone: 'UTC',
};
const queue: QueueOrderV1 = { schema: 'queue.order.v1', version: 1, generatedAt: '', count: 1, parked: 0, lanes: ['codex'], jobs: [{ position: 1, id: 'job-one', repo: 'fake', lane: 'codex', tier: 'work', ageSeconds: 1, family: null, supersededBy: null }] };
const plan = () => buildNodesPlan(readNodesView(view), queue);
const ok: NodeProbe = { reachable: true, cliInstalled: true, signedIn: true };
let runs: string;
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'node-dispatch-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fake(probe: NodeProbe = ok) {
  return { probe: vi.fn(async () => probe), start: vi.fn(async () => ({ started: true, why: '' })) };
}
function run(adapter: NodeDispatchAdapter, options: { dryRun?: boolean; job?: string; node?: string; readPlan?: () => Promise<NodesPlan> } = {}) {
  return dispatchNodeJob({ adapter, runsDir: runs, self: 'local-fake', readPlan: options.readPlan ?? (async () => plan()) }, { job: options.job ?? 'job-one', node: options.node ?? 'remote-fake', dryRun: options.dryRun ?? false });
}
describe('preserved dispatch decision', () => {
  it('passes the real queue lane to the adapter and starts once', async () => {
    const adapter = fake();
    expect(plan().assignable[0]).toMatchObject({ job: 'job-one', node: 'remote-fake', lane: 'codex' });
    expect(await run(adapter)).toMatchObject({ accepted: true, outcome: 'started', lane: 'codex' });
    expect(adapter.probe).toHaveBeenCalledWith('remote-fake', 'codex');
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenCalledWith({ job: 'job-one', node: 'remote-fake', lane: 'codex', branch: 'codex-bridge/job-one' });
  });
  it('never starts on dry run, unknown, offline, missing CLI or signed-out facts', async () => {
    for (const probe of [ok, { ...ok, reachable: 'unknown' as const }, { ...ok, reachable: false }, { ...ok, cliInstalled: false }, { ...ok, signedIn: false }]) {
      const adapter = fake(probe);
      expect((await run(adapter, { dryRun: probe === ok })).accepted).toBe(false);
      expect(adapter.start).not.toHaveBeenCalled();
    }
    expect(await run(planOnlyAdapter)).toMatchObject({ accepted: false, outcome: 'dry-run' });
    expect(await planOnlyAdapter.start({ job: 'x', node: 'y', lane: 'z', branch: 'b' })).toMatchObject({ started: false });
  });
  it('refuses self, missing assignment and missing lane', async () => {
    const adapter = fake();
    expect((await run(adapter, { node: 'local-fake' })).outcome).toBe('refused');
    expect((await run(adapter, { job: 'missing' })).outcome).toBe('refused');
    const missingLane = plan(); delete missingLane.assignable[0]!.lane;
    expect(await run(adapter, { readPlan: async () => missingLane })).toMatchObject({ outcome: 'refused', lane: 'unknown' });
    expect(adapter.start).not.toHaveBeenCalled();
  });
  it('distinguishes absent switches from present and unreadable switches', async () => {
    const adapter = fake();
    expect((await run(adapter, { dryRun: true })).outcome).toBe('dry-run');
    for (const path of ['ORCH_OFF', 'queue/nodes-dispatch.off']) {
      mkdirSync(join(runs, 'queue'), { recursive: true });
      writeFileSync(join(runs, path), '');
      expect((await run(adapter)).outcome).toBe('refused');
      rmSync(join(runs, path));
    }
    // A non-directory parent makes lstat fail with ENOTDIR, not ENOENT.
    rmSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, 'queue'), '');
    expect((await run(adapter)).outcome).toBe('refused');
    expect(adapter.start).not.toHaveBeenCalled();
  });
  it('fails closed on plan, probe and start errors', async () => {
    const adapter = fake();
    expect((await run(adapter, { readPlan: async () => { throw new Error('read'); } })).outcome).toBe('refused');
    adapter.probe.mockRejectedValueOnce(new Error('probe'));
    expect((await run(adapter)).outcome).toBe('dry-run');
    adapter.start.mockRejectedValueOnce(new Error('start'));
    expect((await run(adapter)).outcome).toBe('refused');
  });
});
