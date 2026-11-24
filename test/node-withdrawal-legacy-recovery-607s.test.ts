import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriveNodes, LocalNodesStore, type NodesState } from '../src/core/drive/nodes/index.js';
import { bridgeLeaseOwner, localBridgeRouter, runNodeBridge } from '../src/core/drive/nodes/ready-bridge.js';
import { emptyState, parseState } from '../src/core/drive/nodes/state.js';

const NOW = 1_000_000;
const JOB = 'ready:RQ-REVIEW-LEGACY:1';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-withdrawal-607s-')));
  roots.push(root);
  return root;
}
function legacy(): NodesState {
  return { ...emptyState(), sequence: 3, observedAt: NOW, jobs: [{ id: JOB, owner: 'ashlr', state: 'completed',
    result: 'withdrawn', completedAt: NOW, claim: { jobId: JOB, nodeId: 'withdrawn',
      token: 3, session: 3, leaderToken: 3, expiresAt: NOW } }] };
}
type Job = NodesState['jobs'][number];
const mismatches: [string, (job: Job) => void][] = [
  ['jobId', j => { j.claim!.jobId = 'other'; }],
  ['session', j => { j.claim!.session = 2; }],
  ['leaderToken', j => { j.claim!.leaderToken = 2; }],
  ['zero token', j => { j.claim!.token = j.claim!.session = j.claim!.leaderToken = 0; }],
  ['negative token', j => { j.claim!.token = j.claim!.session = j.claim!.leaderToken = -1; }],
  ['fractional token', j => { j.claim!.token = j.claim!.session = j.claim!.leaderToken = 1.5; }],
  ['out-of-sequence token', j => { j.claim!.token = j.claim!.session = j.claim!.leaderToken = 4; }],
  ['unsafe token', j => { j.claim!.token = j.claim!.session = j.claim!.leaderToken = Number.MAX_SAFE_INTEGER + 1; }],
  ['expiry', j => { j.claim!.expiresAt--; }],
  ['future completion', j => { j.completedAt = j.claim!.expiresAt = NOW + 1; }],
  ['negative completion', j => { j.completedAt = j.claim!.expiresAt = -1; }],
  ['fractional completion', j => { j.completedAt = j.claim!.expiresAt = 1.5; }],
  ['unsafe completion', j => { j.completedAt = j.claim!.expiresAt = Number.MAX_SAFE_INTEGER + 1; }],
  ['NaN completion', j => { j.completedAt = j.claim!.expiresAt = NaN; }],
  ['absent completion', j => { delete j.completedAt; }],
  ['worker node', j => { j.claim!.nodeId = 'worker'; }],
  ['result', j => { j.result = 'done'; }],
  ['running', j => { j.state = 'running'; }],
  ['missing claim', j => { delete j.claim; }],
];

describe('legacy producer withdrawal recovery', () => {
  it.each(mismatches)('does not mark a record with %s mismatch', (_name, change) => {
    const state = legacy();
    change(state.jobs[0]!);
    // Deliberately bypass parseState to exercise the transaction boundary itself.
    const nodes = new DriveNodes({ transaction: fn => fn(state) }, { now: () => NOW });
    expect(nodes.snapshot().jobs[0]!.producerWithdrawn).toBeUndefined();
    expect(state.jobs[0]!.state).not.toBe('pending');
  });

  it('persists recovery across reload, preserving fencing and owner checks', () => {
    const root = directory();
    const store = new LocalNodesStore(root);
    store.transaction(state => Object.assign(state, parseState(legacy())));
    const load = () => new DriveNodes(new LocalNodesStore(root), { now: () => NOW });
    expect(load().withdraw(JOB, 'other-owner')).toEqual({ state: 'absent' });
    expect(load().withdraw(JOB, 'ashlr')).toEqual({ state: 'withdrawn' });
    const recovered = load().snapshot();
    expect(recovered).toEqual({ ...legacy(), jobs: [{ ...legacy().jobs[0]!, producerWithdrawn: true }] });
    expect(load().renewClaim(recovered.jobs[0]!.claim!)).toBeNull();
    expect(load().complete(recovered.jobs[0]!.claim!, 'late')).toBe(false);
  });

  it('leaves already-marked records unchanged', () => {
    const state = legacy();
    state.jobs[0]!.producerWithdrawn = true;
    const before = structuredClone(state);
    const nodes = new DriveNodes({ transaction: fn => fn(state) }, { now: () => NOW });
    expect(nodes.withdraw(JOB, 'ashlr')).toEqual({ state: 'withdrawn' });
    expect(nodes.snapshot()).toEqual(before);
  });

  it('keeps an ordinary worker result literally saying withdrawn completed', () => {
    const nodes = new DriveNodes(new LocalNodesStore(directory()), { now: () => NOW });
    const worker = nodes.join('withdrawn', { owners: ['ashlr'] })!;
    nodes.enqueue(JOB, { owner: 'ashlr' });
    const claim = nodes.pull(worker)!.claim;
    expect(nodes.complete(claim, 'withdrawn')).toBe(true);
    expect(nodes.withdraw(JOB, 'ashlr')).toEqual({ state: 'completed', result: 'withdrawn' });
    expect(nodes.snapshot().jobs[0]!.producerWithdrawn).toBeUndefined();
  });

  it('requeues a matching owner/scope manifest through the current bridge after reload', async () => {
    const root = directory();
    const host = { runsRoot: join(root, 'runs'), wtRoot: join(root, 'wt') };
    for (const d of ['queue/run', 'queue/batches', 'queue/prompts', 'bin']) mkdirSync(join(host.runsRoot, d), { recursive: true });
    copyFileSync(resolve('contrib/mac/dispatchd.py'), join(host.runsRoot, 'bin', 'dispatchd.py'));
    // codex-file offload embeds the prompt, so the row's prompt cell must name a real file.
    const promptPath = join(host.runsRoot, 'queue', 'prompts', 'review.md');
    writeFileSync(promptPath, '# RQ-REVIEW-LEGACY\nBounded fixture task.\n', { mode: 0o600 });
    const row = ['RQ-REVIEW-LEGACY', 'phantom', 'codex-cmp', 'work', promptPath].join('\t') + '\n';
    const ready = join(host.runsRoot, 'queue', 'ready.tsv');
    writeFileSync(ready, row);
    const storeDirectory = join(root, 'nodes');
    const store = new LocalNodesStore(storeDirectory);
    const load = () => new DriveNodes(new LocalNodesStore(storeDirectory), { now: () => NOW });
    const nodes = load();
    nodes.join('fake-worker', { owners: ['ashlr'], caps: ['codex', 'pack:codex-file'], slots: 1 });
    const pass = (current: DriveNodes) => runNodeBridge({ host, router: localBridgeRouter(current, storeDirectory),
      owner: 'ashlr', apply: true, now: NOW });
    expect((await pass(nodes)).claimed).toEqual(['RQ-REVIEW-LEGACY']);
    expect(nodes.withdraw(JOB, 'ashlr')).toEqual({ state: 'withdrawn' });
    store.transaction(state => { delete state.jobs[0]!.producerWithdrawn; });
    const report = await pass(load());
    expect(report.requeued).toEqual(['RQ-REVIEW-LEGACY']);
    expect(report.completed).toEqual([]);
    expect(readFileSync(ready, 'utf8')).toBe(row);
    expect(existsSync(join(host.runsRoot, 'queue/run', 'RQ-REVIEW-LEGACY.batched'))).toBe(false);
    expect(existsSync(join(host.runsRoot, 'queue/batches', `${bridgeLeaseOwner('RQ-REVIEW-LEGACY')}.json`))).toBe(false);
    expect(load().withdraw(JOB, 'ashlr')).toEqual({ state: 'withdrawn' });
  });
});
