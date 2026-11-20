/**
 * `phm nodes dispatch`: decisions over a fake adapter. No computer is contacted;
 * the plan and the runs directory are injected.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdNodes } from '../src/cli/nodes.js';
import { dispatchNodeJob, NODES_DISPATCH_OFF_FILE, NODES_DISPATCH_SCHEMA, planOnlyAdapter, type NodeDispatchAdapter, type NodeProbe } from '../src/core/fleet/nodes-dispatch.js';
import { NODES_PLAN_SCHEMA, type NodesPlan } from '../src/core/fleet/nodes-plan.js';

const plan: NodesPlan = {
  schema: NODES_PLAN_SCHEMA, as_of: '2026-11-19T12:00:00.000Z', unassigned: 0, reasons: [],
  nodes: ['mini', 'studio'].map(name => ({ name, online: true, free_mem_pct: 50, load: 1, lanes: ['claude'], suggested_slots: 2, jobs_running: 0, why: 'ready' })),
  assignable: [{ job: 'job-one', node: 'studio', lane: 'claude', why: 'claude lane: ready' }],
};
let runs: string;
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'dispatch-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); vi.restoreAllMocks(); });

const ok: NodeProbe = { reachable: true, cliInstalled: true, signedIn: true };
function fake(probe: NodeProbe, started = true): NodeDispatchAdapter & { starts: string[] } {
  const starts: string[] = [];
  return { starts, probe: async () => probe, start: async r => { starts.push(`${r.node}:${r.branch}`); return { started, why: 'the worker would not start' }; } };
}
const run = (adapter: NodeDispatchAdapter, dryRun = false, job = 'job-one', node = 'studio') =>
  dispatchNodeJob({ readPlan: async () => plan, adapter, runsDir: runs, self: 'mini' }, { job, node, dryRun });

describe('dispatchNodeJob', () => {
  it('accepts an assignable job on a ready, signed-in computer and starts it once', async () => {
    const adapter = fake(ok);
    const r = await run(adapter);
    expect(r).toMatchObject({ schema: NODES_DISPATCH_SCHEMA, job: 'job-one', node: 'studio', lane: 'claude', accepted: true, outcome: 'started' });
    expect(adapter.starts).toEqual(['studio:codex-bridge/job-one']);
    expect(r.steps.join(' ')).toMatch(/usual publisher/);
  });

  it('--dry-run prints the plan and starts nothing', async () => {
    const adapter = fake(ok);
    const r = await run(adapter, true);
    expect(r).toMatchObject({ accepted: false, outcome: 'dry-run' });
    expect(r.steps).toHaveLength(3);
    expect(adapter.starts).toEqual([]);
  });

  it('an unreachable computer falls back to a dry run with the reason', async () => {
    const adapter = fake({ ...ok, reachable: false });
    const r = await run(adapter);
    expect(r).toMatchObject({ accepted: false, outcome: 'dry-run', why: 'studio is not reachable; showing the plan only.' });
    expect(adapter.starts).toEqual([]);
  });

  it('a missing lane CLI or an unknown login is a dry run, never a start', async () => {
    expect((await run(fake({ ...ok, cliInstalled: false }))).why).toBe('studio does not have the claude CLI; showing the plan only.');
    expect((await run(fake({ ...ok, signedIn: 'unknown' }))).outcome).toBe('dry-run');
    expect((await run(planOnlyAdapter)).outcome).toBe('dry-run');
  });

  it('a computer that is not signed in to the lane is refused with a plain reason', async () => {
    const adapter = fake({ ...ok, signedIn: false });
    const r = await run(adapter);
    expect(r).toMatchObject({ accepted: false, outcome: 'refused', why: 'studio is not signed in to claude.' });
    expect(adapter.starts).toEqual([]);
  });

  it('the kill switch file refuses before anything is read or started', async () => {
    mkdirSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, NODES_DISPATCH_OFF_FILE), '');
    const adapter = fake(ok);
    const r = await run(adapter);
    expect(r).toMatchObject({ accepted: false, outcome: 'refused' });
    expect(r.why).toMatch(/switched off/);
    expect(adapter.starts).toEqual([]);
  });

  it('refuses this computer, unknown computers and jobs the plan did not assign there', async () => {
    expect((await run(fake(ok), false, 'job-one', 'mini')).why).toMatch(/this computer/);
    expect((await run(fake(ok), false, 'job-one', 'nowhere')).why).toMatch(/not a known computer/);
    expect((await run(fake(ok), false, 'job-two')).why).toMatch(/not assignable to studio/);
  });

  it('a start that fails is refused with its reason', async () => {
    const r = await run(fake(ok, false));
    expect(r).toMatchObject({ accepted: false, outcome: 'refused', why: 'studio did not start job-one: the worker would not start.' });
  });
});

describe('phm nodes dispatch', () => {
  const view = { peers: { now: () => new Date(), homeDir: () => '/x', exec: () => { throw new Error('no tailscale'); } }, readRegistry: () => ({ source: 'none' as const, state: null, selfNode: null }),
    localStats: () => { throw new Error('none'); }, hostName: () => 'mini.local', timeZone: 'UTC' };
  const queue = async () => ({ schema: 'queue.order.v1' as const, version: 1 as const, generatedAt: '', count: 0, parked: 0, lanes: [], jobs: [] });

  it('needs a job and --node; --json carries the schema id; refusals exit 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdNodes(['dispatch', 'job-one'], view, queue)).toBe(2);
    expect(err).toHaveBeenCalled();
    expect(await cmdNodes(['dispatch', 'job-one', '--node', 'studio', '--json'], view, queue, planOnlyAdapter, runs)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ schema: NODES_DISPATCH_SCHEMA, job: 'job-one', node: 'studio', accepted: false });
  });
});
