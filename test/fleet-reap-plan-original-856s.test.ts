import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReap } from '../src/cli/fleet-reap.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditEntry } from '../src/core/fleet/wt-audit.js';

const entry = (name: string, state: WtAuditEntry['state'], reapable = true): WtAuditEntry => ({
  name, state, pool: null, repo: 'phantom', bytes: null, sizeComplete: true, ageHours: 100, reapable, via: null,
  blockers: [], signals: {} as WtAuditEntry['signals'],
});
const sources = { worktrees: 'healthy', runs: 'healthy', queue: 'healthy', keep: 'healthy', run: 'healthy', jobs: 'healthy', status: 'healthy', ps: 'healthy', pins: 'valid', sized: false };
function fixture(entries: WtAuditEntry[], source = sources) {
  const evidence = { worktrees: entries, sources: source };
  const remove = vi.fn(async () => undefined);
  const logRemoval = vi.fn(async () => undefined);
  const deps: WorktreesDeps = {
    now: Date.parse('2026-11-17T12:00:00Z'), wtRoot: '/fake', runsRoot: '/fake-runs',
    audit: (async () => evidence) as unknown as WorktreesDeps['audit'],
    isClean: async path => !path.endsWith('DIRTY'), hasUnpushed: async () => false,
    measure: () => ({ bytes: 123, complete: true }), readReapLog: async () => ({ state: 'missing', text: '' }),
    remove, logRemoval,
  };
  return { evidence, deps, remove, logRemoval };
}
afterEach(() => vi.restoreAllMocks());
async function run(args: string[], f: ReturnType<typeof fixture>) {
  const before = structuredClone(f.evidence);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = await cmdFleetReap(args, f.deps);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.logRemoval).not.toHaveBeenCalled();
  expect(f.evidence).toEqual(before);
  const output = out.mock.calls.map(call => String(call[0])).join('\n');
  out.mockRestore(); err.mockRestore();
  return { code, output };
}
describe('fleet reap plan', () => {
  it('discovers the real handler through the generated loader', async () => {
    const resolved = resolveFleetSubcommand('reap');
    expect(resolved?.exportName).toBe('cmdFleetReap');
    expect((await FLEET_SUBCOMMAND_LOADERS.reap!())[resolved!.exportName]).toBe(cmdFleetReap);
  });
  it('bounds safe candidates and counts actual holds', async () => {
    const rows = [
      ...Array.from({ length: 45 }, (_, i) => entry(`RQ-${i}`, 'merged')),
      entry('RQ-LIVE', 'running', false), entry('RQ-OPEN', 'open', false),
      entry('RQ-DIRTY', 'merged'), entry('RQ-KEPT', 'held', false), entry('RQ-UNKNOWN', 'unknown', false),
    ];
    const f = fixture(rows);
    const { code, output } = await run(['--plan', '--json'], f);
    const plan = JSON.parse(output);
    expect(code).toBe(0);
    expect(plan).toMatchObject({ schema: 'fleet.reap-plan.v1', total: 50, cap: 40, waiting: 5,
      held: { 'live-job': 1, 'open-pr': 1, 'uncommitted-changes': 1, kept: 1, 'records-unreadable': 1 } });
    expect(plan.candidates).toHaveLength(40);
    expect(plan.candidates[0].bytes).toBe(123);
    const plain = await run([], f);
    expect(plain.output).toContain('5 waiting');
    expect(plain.output).toContain('uncommitted-changes: 1');
  });
  it('preserves null measurement and handles unreadable evidence', async () => {
    const f = fixture([entry('RQ-NULL', 'merged')]);
    f.deps.measure = () => ({ bytes: null as unknown as number, complete: false });
    expect(JSON.parse((await run(['--json'], f)).output).candidates[0].bytes).toBeNull();
    const blocked = entry('RQ-BLOCKED', 'merged', false);
    const bad = fixture([blocked], { ...sources, jobs: 'unreadable' });
    const report = JSON.parse((await run(['--json'], bad)).output);
    expect(report.sourcesOk).toBe(false);
    expect(report.candidates).toHaveLength(0);
    expect(report.held['records-unreadable']).toBe(1);
  });
  it('rejects unsafe, duplicate and unknown flags and accepts help', async () => {
    const f = fixture([]);
    for (const args of [['--apply'], ['--force'], ['--plan', '--plan'], ['--help', '--json'], ['--wat']]) {
      expect((await run(args, f)).code).toBe(2);
    }
    expect((await run(['--help'], f)).code).toBe(0);
    expect((await run(['--plan'], f)).code).toBe(0);
  });
});
