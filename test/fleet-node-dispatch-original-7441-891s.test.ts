import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetNodeDispatch } from '../src/cli/fleet-node-dispatch.js';
import { planOnlyAdapter, type NodeDispatchDeps, type NodeProbe } from '../src/core/fleet/nodes-dispatch.js';
import type { NodesPlan } from '../src/core/fleet/nodes-plan.js';

let root: string;
const plan: NodesPlan = { schema: 'phantom.nodes-plan.v1', as_of: '', nodes: [{ name: 'remote', online: true, free_mem_pct: 'unknown', load: 'unknown', lanes: ['codex'], suggested_slots: 1, why: '' }], assignable: [{ job: 'job', node: 'remote', lane: 'codex', why: '' }], unassigned: 0, reasons: [] };
const ready: NodeProbe = { reachable: true, cliInstalled: true, signedIn: true };
function fixture(probe: NodeProbe = ready): NodeDispatchDeps {
  return { runsDir: root, self: 'local', readPlan: vi.fn(async () => plan), adapter: { probe: vi.fn(async () => probe), start: vi.fn(async () => ({ started: true, why: '' })) } };
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-node-')); vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const args = ['job', '--node', 'remote', '--json'];
const output = () => JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string) as Record<string, unknown>;

describe('fleet node-dispatch caller', () => {
  it('discovers the command through the real fleet loader', async () => {
    expect(FLEET_SUBCOMMAND_LOADERS['node-dispatch']).toBeTypeOf('function');
    expect(await cmdFleet(['node-dispatch', '--help'], FLEET_SUBCOMMAND_LOADERS)).toBe(0);
    expect(vi.mocked(console.log).mock.lastCall![0]).toContain('node-dispatch');
  });
  it('rejects malformed arguments before reading or probing', async () => {
    const deps = fixture();
    for (const input of [[], ['job'], ['job', '--node'], ['job', '--node', '--json'], ['job', '--node', 'remote', '--node', 'other'], [...args, '--json'], [...args, '--dry-run', '--dry-run'], [...args, 'extra'], [...args, '--bad']]) {
      expect(await cmdFleetNodeDispatch(input, deps)).toBe(2);
    }
    expect(await cmdFleetNodeDispatch(['--help'], deps)).toBe(0);
    expect(deps.readPlan).not.toHaveBeenCalled(); expect(deps.adapter.probe).not.toHaveBeenCalled();
  });
  it('propagates a ready adapter result and preserves the JSON contract', async () => {
    const deps = fixture();
    expect(await cmdFleetNodeDispatch(args, deps)).toBe(0);
    expect(output()).toMatchObject({ schema: 'phantom.nodes-dispatch.v1', job: 'job', node: 'remote', lane: 'codex', accepted: true, outcome: 'started' });
    expect(deps.adapter.start).toHaveBeenCalledOnce();
  });
  it('keeps dry runs and unknown login as plans, and refuses signed out', async () => {
    for (const [probe, flags, outcome, code] of [[ready, ['--dry-run'], 'dry-run', 0], [{ ...ready, signedIn: 'unknown' }, [], 'dry-run', 0], [{ ...ready, signedIn: false }, [], 'refused', 1]] as const) {
      const deps = fixture(probe);
      expect(await cmdFleetNodeDispatch([...args, ...flags], deps)).toBe(code);
      expect(output()).toMatchObject({ outcome, accepted: false });
      expect(deps.adapter.start).not.toHaveBeenCalled();
    }
  });
  it('uses the non-launching adapter and retains unknown evidence', async () => {
    const deps = { ...fixture(), adapter: planOnlyAdapter };
    expect(await cmdFleetNodeDispatch(args, deps)).toBe(0);
    expect(output()).toMatchObject({ outcome: 'dry-run', accepted: false });
    expect(output().why).toContain('could not be checked');
    expect((await planOnlyAdapter.start({ job: 'job', node: 'remote', lane: 'codex', branch: 'fake' })).started).toBe(false);
  });
  it('honors both off switches before reading or probing', async () => {
    for (const file of ['ORCH_OFF', 'queue/nodes-dispatch.off']) {
      mkdirSync(join(root, 'queue'), { recursive: true }); writeFileSync(join(root, file), '');
      const deps = fixture();
      expect(await cmdFleetNodeDispatch(args, deps)).toBe(1);
      expect(output()).toMatchObject({ outcome: 'refused', lane: 'unknown', accepted: false });
      expect(deps.readPlan).not.toHaveBeenCalled(); expect(deps.adapter.probe).not.toHaveBeenCalled();
      rmSync(join(root, file));
    }
  });
});
