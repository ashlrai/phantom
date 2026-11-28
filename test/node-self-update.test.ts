import { describe, expect, it, vi, afterEach } from 'vitest';
import { compareVersions, planNodeSelfUpdate, versionCap, versionFromCaps } from '../src/core/drive/nodes/phm-version.js';
import { cmdNodeSelfUpdate } from '../src/cli/node-self-update.js';

const node = (nodeId: string, caps: string[], slots?: number) => ({ nodeId, live: true, caps, ...(slots === undefined ? {} : { slots }) });

describe('node phm version reporting and drift plan', () => {
  it('round-trips a version through a valid capability and rejects junk', () => {
    expect(versionCap('3.30.34')).toBe('phm-3.30.34');
    expect(versionFromCaps(['codex', 'phm-3.30.34'])).toBe('3.30.34');
    for (const bad of [null, 'unknown', '3.30', '3.30.34+build', '../x']) expect(versionCap(bad)).toBeNull();
    expect(versionFromCaps(['codex', 'phm-latest', 'phm-'])).toBeNull();
  });
  it('compares numerically, not lexically', () => {
    expect(compareVersions('3.30.9', '3.30.34')).toBeLessThan(0);
    expect(compareVersions('3.31.0', '3.30.34')).toBeGreaterThan(0);
    expect(compareVersions('3.30.34', '3.30.34')).toBe(0);
  });
  it('flags behind and unreported nodes and keeps current/ahead out of the drift list', () => {
    const plan = planNodeSelfUpdate([
      node('muse', ['codex', 'phm-3.30.34'], 4), node('w2', ['codex', 'phm-3.30.20'], 1), node('w3', ['codex']), node('w4', ['phm-3.31.0']),
    ], '3.30.34');
    expect(plan.nodes.map(n => n.status)).toEqual(['current', 'behind', 'unreported', 'ahead']);
    expect(plan.drifted).toEqual(['w2', 'w3']);
    expect(plan).toMatchObject({ dryRun: true, executable: false });
  });
  it('reports no drift for an empty or matching pool', () => {
    expect(planNodeSelfUpdate([], '3.30.34').drifted).toEqual([]);
    expect(planNodeSelfUpdate([node('a', ['phm-3.30.34'])], '3.30.34').steps).toEqual(['No drift: every reporting node matches the target.']);
  });
  it('reads reported versions unknown, never current, when no target can be judged', () => {
    const plan = planNodeSelfUpdate([
      node('w1', ['codex', 'phm-3.30.1'], 4), node('w2', ['codex']), node('w3', ['phm-3.30.34']),
    ], null);
    expect(plan.nodes.map(n => n.status)).toEqual(['unknown', 'unreported', 'unknown']);
    expect(plan.drifted).toEqual(['w2']);
    const steps = plan.steps.join(' ');
    expect(steps).toContain('--target');
    expect(steps).not.toContain('matches the target');
    expect(planNodeSelfUpdate([node('a', ['phm-3.30.34'])], null).steps.join(' ')).not.toContain('No drift');
  });
  it('treats a target compareVersions cannot order as unjudgeable, not equal', () => {
    for (const target of ['not-a-version', '3.30.34-RC1']) {
      const plan = planNodeSelfUpdate([node('w1', ['phm-3.30.34'])], target);
      expect(plan.nodes[0]!.status).toBe('unknown');
      expect(plan.steps.join(' ')).toContain('not a comparable release version');
    }
  });
});

describe('phm node self-update', () => {
  afterEach(() => vi.restoreAllMocks());
  const run = async (args: string[], nodes = [node('w2', ['phm-3.30.1'], 1)]) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    vi.spyOn(console, 'error').mockImplementation((s: string) => { out.push(s); });
    const nodesFn = vi.fn(async () => nodes);
    const code = await cmdNodeSelfUpdate(args, { nodes: nodesFn, localVersion: () => '3.30.34' });
    return { code, out: out.join('\n'), nodesFn };
  };
  it('prints a JSON plan against the local version by default', async () => {
    const { code, out, nodesFn } = await run(['--owner', 'ashlr', '--json']);
    expect(code).toBe(0);
    expect(nodesFn).toHaveBeenCalledWith('ashlr');
    expect(JSON.parse(out)).toMatchObject({ target: '3.30.34', drifted: ['w2'], executable: false });
  });
  it('refuses any flag that could apply an update, and bad values, before reading nodes', async () => {
    for (const args of [['--apply'], ['--owner'], ['--target', 'latest'], ['--owner', 'a b'], ['--owner=a', '--owner=b']]) {
      const { code, nodesFn } = await run(args);
      expect(code).toBe(2);
      expect(nodesFn).not.toHaveBeenCalled();
    }
  });
  it('reports unknown drift, not current, when the local version is undeterminable', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s); });
    const nodesFn = vi.fn(async () => [node('w1', ['phm-3.30.1'], 1), node('w2', ['codex'])]);
    const code = await cmdNodeSelfUpdate(['--owner', 'ashlr', '--json'], { nodes: nodesFn, localVersion: () => null });
    expect(code).toBe(0);
    const plan = JSON.parse(out.join('\n'));
    expect(plan.target).toBeNull();
    expect(plan.nodes.map((n: { status: string }) => n.status)).toEqual(['unknown', 'unreported']);
    expect(plan.drifted).toEqual(['w2']);
    expect(plan.steps.join(' ')).not.toContain('matches the target');
  });
  it('returns a fixed error when the registry cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdNodeSelfUpdate(['--owner', 'ashlr'], { nodes: async () => { throw new Error('ssh secret detail'); }, localVersion: () => '1.0.0' })).toBe(1);
  });
});
