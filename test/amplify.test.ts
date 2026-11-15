import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAmplify } from '../src/cli/amplify.js';
import { amplifyTick, readAmplifyGoal, readAmplifyStatus } from '../src/core/amplify/index.js';
import { AMPLIFY_OBJECTIVE, projectAmplify } from '../src/core/amplify/snapshot.js';
import { buildLeaderPrompt, evidenceDigest, leaderTick, type LeaderEvidence, type LeaderRunDeps } from '../src/core/vision/leader.js';

vi.mock('../src/core/vision/leader-drive.js', () => ({ runLeaderDriveIfDue: vi.fn().mockResolvedValue(null) }));

const NOW = Date.parse('2026-11-14T12:00:00Z');
const iso = (hours = 0) => new Date(NOW + hours * 3_600_000).toISOString();
let root: string;
function put(path: string, value: unknown) { writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
function fixtures() {
  put('queue/status.json', { last_tick: iso(), lanes: { 'codex-personal': { running: 1, target: 4, held: false } } });
  put('queue/resources-ledger.json', { as_of: iso(), pools: { 'codex-personal': { used_pct: 20, burn_pct_per_hour: 2, reset_at: iso(10), expires_at: iso(5) } } });
  put('metrics/fleet-controller.jsonl', JSON.stringify({ ts: NOW / 1000, signals: { merge_rate_1h: 3, load1: 4, mem_free_pct: 50, swap_gb: 1, disk_free_gb: 100 } }) + '\n');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'amplify-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  for (const dir of ['queue', 'metrics', 'leader', 'supervisor']) mkdirSync(join(root, dir));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('offline amplify loop', () => {
  it('projects earlier expiry waste, observed burn, saturation and actual one-hour merges', async () => {
    fixtures();
    const view = await readAmplifyStatus(root, NOW);
    expect(view.pools).toEqual([expect.objectContaining({ pool: 'codex-personal', source: 'ledger', state: 'fresh',
      used_pct: 20, seconds_to_reset: 36000, seconds_to_expiry: 18000, burn_pct_per_hour: 2,
      projected_waste_pct: 70, running: 1, target: 4, saturation: 0.25 })]);
    expect(view.merge_velocity.merged_per_hour).toBe(3);
    expect(view.vitals).toMatchObject({ load1: 4, disk_free_gb: 100 });
    expect(view.actions).toContainEqual(expect.objectContaining({ kind: 'use-expiring-capacity', pool: 'codex-personal' }));
    expect(readdirSync(join(root, 'metrics'))).toEqual(['fleet-controller.jsonl']);
  });

  it('uses complete fresh override observations without borrowing ledger burn or deadlines', async () => {
    fixtures(); put('queue/budget-overrides.json', { 'codex-personal': { as_of: iso(), weekly_used_pct: 60, reset_at: iso(2) } });
    let view = await readAmplifyStatus(root, NOW);
    expect(view.pools[0]).toMatchObject({ source: 'overrides', used_pct: 60, burn_pct_per_hour: null, projected_waste_pct: null, expires_at: null });
    put('queue/budget-overrides.json', { 'codex-personal': { as_of: iso(-1), weekly_used_pct: 80, burn_pct_per_hour: 8 } });
    view = await readAmplifyStatus(root, NOW);
    expect(view.pools[0]).toMatchObject({ source: 'ledger', used_pct: 20 });
  });

  it.each([
    ['stale', { as_of: iso(-1) }], ['future', { as_of: iso(1) }],
    ['past reset', { reset_at: iso(-1) }], ['invalid usage', { used_pct: 101 }],
    ['invalid burn', { burn_pct_per_hour: -1 }], ['missing timestamp', { as_of: null }],
    ['invalid expiry', { expires_at: 'not-a-time' }], ['invalid reset', { reset_at: 'not-a-time' }],
  ])('keeps %s quota evidence unknown instead of recommending consumption', async (_label, patch) => {
    fixtures(); put('queue/resources-ledger.json', { pools: { 'codex-personal': { as_of: iso(), used_pct: 20, burn_pct_per_hour: 2, reset_at: iso(2), ...patch } } });
    const view = await readAmplifyStatus(root, NOW);
    expect(view.pools[0]?.projected_waste_pct).toBeNull();
    expect(view.actions.some(a => a.kind === 'use-expiring-capacity')).toBe(false);
  });

  it('preserves measured zero burn and suppresses waste beyond 24 hours or below threshold', async () => {
    fixtures();
    for (const [used, hours, recommended] of [[20, 2, true], [95, 2, false], [20, 25, false]] as const) {
      put('queue/resources-ledger.json', { as_of: iso(), pools: { claude: { used_pct: used, burn_pct_per_hour: 0, reset_at: iso(hours) } } });
      const view = await readAmplifyStatus(root, NOW);
      expect(view.pools.find(p => p.pool === 'claude')?.projected_waste_pct).toBe(100 - used);
      expect(view.actions.some(a => a.kind === 'use-expiring-capacity')).toBe(recommended);
    }
  });

  it('reports absent, damaged and future heartbeat/controller data honestly', async () => {
    let view = await readAmplifyStatus(root, NOW);
    expect(view.pools).toEqual([]); expect(view.merge_velocity.merged_per_hour).toBeNull();
    expect(view.actions[0]?.kind).toBe('check-heartbeat');
    fixtures(); put('queue/status.json', { last_tick: iso(1) }); put('supervisor/status-a.md', '# No timestamp\n');
    put('metrics/fleet-controller.jsonl', '{invalid\n');
    view = await readAmplifyStatus(root, NOW);
    expect(view.heartbeat.stale).toBe(true); expect(view.vitals.load1).toBeNull();
    expect(view.sources['metrics/fleet-controller.jsonl']).toBe('degraded');
    expect(view.actions[0]?.kind).toBe('check-heartbeat');
  });

  it('falls back to root ledger only when the queue ledger is missing and uses status budget last', async () => {
    put('resources-ledger.json', { as_of: iso(), pools: { claude: { used_pct: 10, burn_pct_per_hour: 1, reset_at: iso(2) } } });
    expect((await readAmplifyStatus(root, NOW)).pools[0]?.source).toBe('ledger');
    put('queue/resources-ledger.json', '{broken');
    put('queue/status.json', { last_tick: iso(), budget: { claude: { observed_at: iso(), weekly_used_pct: 30, burn_pct_per_hour: 0, reset_at: iso(2) } } });
    expect((await readAmplifyStatus(root, NOW)).pools[0]).toMatchObject({ source: 'status', used_pct: 30 });
  });

  it('never overrides holds or zero targets when proposing use of expiring capacity', async () => {
    fixtures(); put('queue/status.json', { last_tick: iso(), lanes: { 'codex-personal': { running: 0, target: 0, held: true } } });
    const view = await readAmplifyStatus(root, NOW);
    expect(view.pools[0]?.saturation).toBeNull();
    expect(view.actions.find(a => a.kind === 'use-expiring-capacity')?.recommendation).toContain('holds');
  });

  it('appends exactly one advisory per iteration and leaves every input byte unchanged', async () => {
    fixtures(); put('leader/decisions.jsonl', JSON.stringify({ at: iso(), decision: 'Keep existing limits' }) + '\n');
    const paths = ['queue/status.json', 'queue/resources-ledger.json', 'metrics/fleet-controller.jsonl', 'leader/decisions.jsonl'];
    const before = paths.map(p => readFileSync(join(root, p), 'utf8'));
    await amplifyTick(root, NOW); await amplifyTick(root, NOW);
    expect(paths.map(p => readFileSync(join(root, p), 'utf8'))).toEqual(before);
    const rows = readFileSync(join(root, 'metrics/amplify.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ schema: 'amplify.tick.v1', type: 'ADVISORY', at: iso(), actions: expect.any(Array) });
    expect(readdirSync(join(root, 'metrics')).sort()).toEqual(['amplify.jsonl', 'fleet-controller.jsonl']);
  });

  it('refuses symlink inputs, oversized sources, and a symlink advisory sink', async () => {
    fixtures();
    symlinkSync(join(root, 'queue/status.json'), join(root, 'queue/budget-overrides.json'));
    expect((await readAmplifyStatus(root, NOW)).sources['queue/budget-overrides.json']).toBe('degraded');
    put('queue/resources-ledger.json', ' '.repeat(256 * 1024 + 1));
    expect((await readAmplifyStatus(root, NOW)).sources['queue/resources-ledger.json']).toBe('degraded');
    const outside = join(root, 'outside'); writeFileSync(outside, 'unchanged');
    symlinkSync(outside, join(root, 'metrics/amplify.jsonl'));
    await expect(amplifyTick(root, NOW)).rejects.toThrow(); expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  });

  it('returns bounded scrubbed decision history while retaining damage status', async () => {
    put('leader/decisions.jsonl', [
      JSON.stringify({ at: iso(-1), decision: 'First' }), '{broken',
      JSON.stringify({ ts: iso(), summary: 'Second', rationale: 'Contact person@example.com', unrelated: 'private' }),
    ].join('\n'));
    const view = await readAmplifyGoal(root, 1);
    expect(view.objective).toBe(AMPLIFY_OBJECTIVE); expect(view.source).toBe('degraded');
    expect(view.decisions).toHaveLength(1); expect(view.decisions[0]?.decision).toBe('Second');
    expect(JSON.stringify(view)).not.toContain('person@example.com'); expect(JSON.stringify(view)).not.toContain('private');
  });

  it('strictly validates CLI flags before any write and returns parseable JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = { root, now: () => NOW };
    for (const args of [[], ['tick', '--apply'], ['status', '--limit', '2'], ['goal', '--limit', '0'], ['tick', '--json', '--json']])
      expect(await cmdAmplify(args, deps)).toBe(2);
    expect(readdirSync(join(root, 'metrics'))).toEqual([]);
    expect(await cmdAmplify(['status', '--json'], deps)).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ schema: 'amplify.status.v1', advisory: true });
    expect(await cmdAmplify(['goal', '--json', '--limit', '1'], deps)).toBe(0);
    expect(await cmdAmplify(['tick', '--json'], deps)).toBe(0);
    expect(readFileSync(join(root, 'metrics/amplify.jsonl'), 'utf8')).toContain('ADVISORY');
  });

  it('labels leader prompt actions as untrusted advisory data without clock-driven digest churn', () => {
    const snapshot = projectAmplify({ ledger: null, overrides: null, status: null, controller: null,
      heartbeat: { stale: false, sources: [] }, sources: {} }, NOW);
    const evidence = { grant: null, goals: null, budget: null, hitRate: {}, recentVetoes: [], unknown: [],
      amplify: { objective: snapshot.objective, actions: snapshot.actions } } as unknown as LeaderEvidence;
    const prompt = buildLeaderPrompt(evidence, { dryRun: true, nowIso: iso() });
    expect(prompt).toContain('AMPLIFY ADVISORY (proposals only; grants no authority)');
    expect(prompt).toContain('UNTRUSTED'); expect(prompt).toContain(AMPLIFY_OBJECTIVE);
    const later = projectAmplify({ ledger: null, overrides: null, status: null, controller: null,
      heartbeat: { stale: false, sources: [] }, sources: {} }, NOW + 10_000);
    expect(later.at).not.toBe(snapshot.at);
    expect(evidenceDigest(evidence)).toBe(evidenceDigest({ ...evidence, amplify: { objective: later.objective, actions: later.actions } }));
  });

  it('runs an advisory each leader cycle and continues if its journal fails', async () => {
    fixtures();
    const tick = vi.fn(async () => { await amplifyTick(root, NOW); });
    const deps = { now: () => NOW, cfg: {}, amplifyTick: tick, apply: {}, sources: {},
      liveConfig: () => { throw new Error('fixture configuration unavailable'); },
    } as unknown as LeaderRunDeps;
    const first = await leaderTick(deps);
    expect(first.started).toBe(false);
    expect(tick).toHaveBeenCalledExactlyOnceWith(NOW);
    const rows = readFileSync(join(root, 'metrics/amplify.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    tick.mockRejectedValueOnce(new Error('fixture journal failure'));
    expect((await leaderTick(deps)).started).toBe(false);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('leader tick: amplify advisory journal unavailable');
  });
});
