import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DriveNodes } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
import { emptyState, parseState, type NodesStore } from '../src/core/drive/nodes/state.js';
import { lightRecipe, restockLight, runLightJob, type NodeCall } from '../src/core/drive/nodes/light.js';
import { assessNodeCapacity } from '../src/core/drive/nodes/capacity.js';

function fixture() {
  let now = 3_600_001;
  let state = emptyState();
  const store: NodesStore = { transaction: fn => {
    const draft = structuredClone(state);
    const result = fn(draft);
    state = parseState(draft);
    return structuredClone(result);
  } };
  const nodes = new DriveNodes(store, { now: () => now, nodeTtlMs: 600_000 });
  const call = vi.fn<NodeCall>((v, a) => executeNodeFleet(v, a, nodes));
  const join = () => nodes.join('muse', { owners: ['ashlr'], caps: ['light', 'gh', 'comms'], slots: 2 })!;
  return { nodes, call, join, tick: (ms: number) => { now += ms; }, stock: (apply = true) => restockLight(call, apply, now) };
}

describe('muse isolated light slice', () => {
  it('waits for muse, previews without enqueue and deduplicates actual admission', () => {
    const f = fixture();
    expect(f.stock().planned).toEqual([]);
    const session = f.join();
    expect(f.stock(false).planned).toHaveLength(2);
    expect(f.nodes.view(['ashlr']).jobs).toEqual([]);
    expect(f.stock().enqueued).toBe(2);
    expect(f.stock().enqueued).toBe(0);
    const jobs = f.nodes.view(['ashlr']).jobs;
    expect(jobs.every(j => j.owner === 'ashlr' && j.requires.includes('light') && j.secrets.length === 0)).toBe(true);
    const first = f.nodes.pull(session)!;
    const second = f.nodes.pull(session)!;
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(f.nodes.pull(session)).toBeNull();
    expect(f.stock().outstanding).toBe(2);
    f.nodes.complete(first.claim, 'light:channels-status:1');
    expect(f.stock()).toMatchObject({ enqueued: 1, completed: 1, museCompleted: 1 });
    expect(f.stock().completions[0]).toMatchObject({ nodeId: 'muse', jobId: first.job.id });
    // A second owner cannot see muse jobs or their executor identities.
    expect(f.nodes.view(['other']).jobs).toEqual([]);
  });

  it('retains pending work across hour boundaries and does not inflate completions', () => {
    const f = fixture(); const session = f.join();
    f.stock(); const first = f.nodes.pull(session)!;
    f.tick(3_600_000);
    expect(f.nodes.complete(first.claim, 'late')).toBe(false);
    expect(f.stock()).toMatchObject({ enqueued: 0, outstanding: 2, museCompleted: 0 });
  });

  it.each([
    { slots: 0 }, { slots: 1 }, { slots: undefined }, { usage: 900 },
    { caps: ['gh'] }, { owners: ['other'] }, { live: false },
    { heartbeatAt: 0 }, { heartbeatAt: 3_600_002 }, { heartbeatAt: 3_300_001 }, { expiresAt: 3_600_001 },
  ])('holds admission with inadequate muse evidence %j', patch => {
    const f = fixture(); f.join();
    const view = f.nodes.view(['ashlr']);
    Object.assign(view.nodes[0]!, patch);
    const call = vi.fn<NodeCall>(() => view);
    expect(restockLight(call, true, 3_600_001).enqueued).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('counts only accepted muse completions, without exposing result bodies', () => {
    const f = fixture(); f.join(); f.stock();
    const view = f.nodes.view(['ashlr']);
    view.jobs[0] = { ...view.jobs[0]!, state: 'completed', completedBy: 'other-node' };
    const report = restockLight(() => view, false, 3_600_001);
    expect(report.completed).toBe(1); expect(report.museCompleted).toBe(0);
    expect(report.completions[0]?.nodeId).toBe('other-node');
  });

  it('adds two light slots without changing provider capacity or pressure floors', () => {
    const memory = { freePercent: 60, swapGb: 0, pressureLevel: 1 as const };
    expect(assessNodeCapacity(8 * 1024 ** 3, memory, 30e9).slots).toBe(1);
    expect(assessNodeCapacity(8 * 1024 ** 3, memory, 30e9, true).slots).toBe(2);
    expect(assessNodeCapacity(8 * 1024 ** 3, { ...memory, pressureLevel: 2 }, 30e9, true).slots).toBe(0);
    expect(assessNodeCapacity(8 * 1024 ** 3, memory, 19e9, true).slots).toBe(0);
    expect(assessNodeCapacity(8 * 1024 ** 3, null, 30e9, true).slots).toBe(0);
  });

  it('runs a fixed command with bounded memory/time and no retained diagnostics', async () => {
    const f = fixture(); const session = f.join(); f.stock();
    const pulled = f.nodes.pull(session)!;
    const run = vi.fn(() => ({ status: 0 }));
    const result = await runLightJob(Readable.from([JSON.stringify({ protocol: 'phm-node-worker/v1', ...pulled })]), run as never);
    expect(result.resultRef).toMatch(/^light:channels-status:/);
    expect(run).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--max-old-space-size=256', 'channels', 'status']),
      expect.objectContaining({ stdio: 'ignore', timeout: 120_000 }));
    expect(f.nodes.complete(pulled.claim, result.resultRef)).toBe(true);
    expect(f.stock(false).museCompleted).toBe(1);
  });

  it('refuses secret references, arbitrary packs, oversized inputs and failed commands', async () => {
    const f = fixture(); const session = f.join(); f.stock();
    const pulled = f.nodes.pull(session)!;
    const run = vi.fn(() => ({ status: 1 }));
    for (const patch of [{ secrets: ['LOCAL_KEY'] }, { pack: 'build' }, { requires: ['light', 'build'] }]) {
      const job = { ...pulled.job, ...patch };
      expect(lightRecipe(job)).toBeUndefined();
      await expect(runLightJob(Readable.from([JSON.stringify({ protocol: 'phm-node-worker/v1', ...pulled, job })]), run as never)).rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
    await expect(runLightJob(Readable.from(['x'.repeat(16_385)]), run as never)).rejects.toThrow(/large/);
    await expect(runLightJob(Readable.from([JSON.stringify({ protocol: 'phm-node-worker/v1', ...pulled })]), run as never)).rejects.toThrow(/failed/);
  });
});
