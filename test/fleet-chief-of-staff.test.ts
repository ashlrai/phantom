import { describe, expect, it, vi } from 'vitest';
import { planChiefOfStaff, parseFleetSnapshot, CHIEF_OF_STAFF_LIMITS, type FleetSnapshot } from '../src/core/fleet/chief-of-staff.js';
import { cmdFleetChiefOfStaff } from '../src/cli/fleet-chief-of-staff.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const at = '2026-11-14T12:00:00.000Z';
const ago = (hours: number) => new Date(Date.parse(at) - hours * 3_600_000).toISOString();
const lane = (extra: Partial<FleetSnapshot['lanes'][number]> = {}): FleetSnapshot['lanes'][number] => ({
  lane: 'codex', held: false, target: 4, ceiling: 5, queueDepth: 8, running: 1,
  errorRate: 0, emptyRate: 0, openPrConflicts: 0, quota: { remainingFraction: 0.8, resetAt: ago(-0.5) }, ...extra,
});
const job = (id: string, extra: Partial<FleetSnapshot['jobs'][number]> = {}): FleetSnapshot['jobs'][number] => ({
  id, lane: 'codex', status: 'ready', priority: 50, queuedAt: ago(7), startedAt: null, ...extra,
});
const snapshot = (extra: Partial<FleetSnapshot> = {}): FleetSnapshot => ({ at, lanes: [lane()], jobs: [job('RQ-A')], outcomes: [], ...extra });
const outcome = (extra: Partial<FleetSnapshot['outcomes'][number]> = {}): FleetSnapshot['outcomes'][number] => ({
  job: 'RQ-A', lane: 'codex', at: ago(2), phase: 'finish', result: 'success', ...extra,
});

describe('chief-of-staff pure planning', () => {
  it('ranks priorities and aging deterministically without mutating evidence', () => {
    const input = snapshot({ jobs: [job('old'), job('new', { queuedAt: ago(0) }), job('urgent', { priority: 99 })] });
    const copy = structuredClone(input), plan = planChiefOfStaff(input);
    expect(plan).toEqual(planChiefOfStaff(input)); expect(input).toEqual(copy);
    expect(plan.ordering.map(j => j.job)).toEqual(['urgent', 'old', 'new']);
    expect(plan.ordering[1]).toMatchObject({ score: 527, rationale: 'Priority 50; age +7; reset +20; health/conflict -0.' });
    expect(plan.laneTargets[0]).toMatchObject({ recommended: 5, reason: 'use-reset-window' });
    expect(plan.authority).toEqual({ mode: 'recommend-only', allowed: ['reorder', 'inject', 'retire', 'brief'], merge: false, credentials: false, bypassLaneHolds: false });
  });
  it('keeps queue order for equal scores across lanes', () => {
    const plan = planChiefOfStaff(snapshot({ lanes: [lane(), lane({ lane: 'alpha' })], jobs: [job('first'), job('second', { lane: 'alpha' })] }));
    expect(plan.ordering.map(j => j.job)).toEqual(['first', 'second']);
  });
  it.each([
    [{ held: true }, 'lane-held', 0], [{ held: null }, 'hold-unknown', null],
    [{ target: 0 }, 'lane-disabled', 0], [{ quota: null }, 'quota-unknown', null],
    [{ quota: { remainingFraction: 0, resetAt: ago(-1) } }, 'quota-exhausted', 0],
    [{ quota: { remainingFraction: 1, resetAt: ago(1) } }, 'quota-unknown', null],
  ] as const)('preserves holds and quota limits: %j', (extra, reason, recommended) => {
    const plan = planChiefOfStaff(snapshot({ lanes: [lane({ ...extra, errorRate: 1 })], outcomes: [outcome({ phase: 'publish' })] }));
    expect(plan.laneTargets[0]).toMatchObject({ reason, recommended });
    for (const field of ['ordering', 'inject', 'retire', 'stuck'] as const) expect(plan[field]).toEqual([]);
  });
  it('reduces failing lanes and proposes bounded repair and conflict work', () => {
    const plan = planChiefOfStaff(snapshot({ lanes: [lane({ errorRate: 0.5 }), lane({ lane: 'claude', openPrConflicts: 3 })] }));
    expect(plan.laneTargets.map(l => l.recommended)).toEqual([4, 2]);
    expect(plan.inject.map(j => j.purpose)).toEqual(['resolve-conflicts', 'repair-lane']);
    expect(plan.ordering[0].score).toBe(477);
    expect(planChiefOfStaff(snapshot({ lanes: [lane({ target: 8, ceiling: 3 })] })).laneTargets[0]).toMatchObject({ current: 8, recommended: 3 });
  });
  it('replenishes only measured empty queues and avoids existing or recently attempted work', () => {
    const input = snapshot({ lanes: [lane({ queueDepth: 0 })], jobs: [] });
    const proposed = planChiefOfStaff(input).inject[0];
    expect(proposed.purpose).toBe('replenish-queue');
    expect(planChiefOfStaff({ ...input, jobs: [job(proposed.job, { status: 'running' })] }).inject).toEqual([]);
    expect(planChiefOfStaff({ ...input, outcomes: [outcome({ job: proposed.job })] }).inject).toEqual([]);
    expect(planChiefOfStaff(snapshot({ lanes: [lane({ queueDepth: null, errorRate: null })] })).laneTargets[0]).toMatchObject({ recommended: 4, reason: 'evidence-incomplete' });
  });
  it('retires only ready work with successful publication tied to its queue entry', () => {
    expect(planChiefOfStaff(snapshot({ outcomes: [outcome({ phase: 'publish' })] })).retire).toEqual([{ job: 'RQ-A', lane: 'codex', reason: 'already-published' }]);
    for (const event of [outcome(), outcome({ phase: 'publish', result: 'failed' }), outcome({ phase: 'publish', at: ago(8) }), outcome({ phase: 'publish', at: ago(-1) })]) {
      expect(planChiefOfStaff(snapshot({ outcomes: [event] })).retire).toEqual([]);
    }
    expect(planChiefOfStaff(snapshot({ jobs: [job('RQ-A', { queuedAt: null })], outcomes: [outcome({ phase: 'publish' })] })).retire).toEqual([]);
    expect(planChiefOfStaff(snapshot({ outcomes: [outcome({ phase: 'publish' }), outcome({ phase: 'publish', at: ago(1), result: 'failed' })] })).retire).toEqual([]);
  });
  it('detects overdue work and missing proof without aging parked or undated jobs', () => {
    const plan = planChiefOfStaff(snapshot({ jobs: [job('RQ-A', { status: 'running', startedAt: ago(3) }), job('wait'), job('parked', { status: 'parked' }), job('unknown', { queuedAt: null }), job('future', { queuedAt: ago(-1) })], outcomes: [outcome(), outcome()] }));
    expect(plan.stuck.map(j => [j.job, j.reason])).toEqual([['RQ-A', 'run-overdue'], ['RQ-A', 'proof-missing'], ['wait', 'queue-wait']]);
    expect(plan.evidence.recentFinishes).toBe(1);
    expect(planChiefOfStaff(snapshot({ jobs: [job('RQ-A', { status: 'running', startedAt: ago(0.5) })], outcomes: [outcome()] })).stuck).toEqual([]);
  });
  it('keeps the brief and JSON free of home paths and unknown fields', () => {
    const input = { ...snapshot(), prompt: '/Users/private/person/prompt.md', authority: { merge: true } };
    const plan = planChiefOfStaff(input);
    expect(plan.brief.text).toContain('# Fleet chief of staff');
    expect(JSON.stringify(plan)).not.toMatch(/\/Users|prompt\.md/);
    expect(() => parseFleetSnapshot({ ...input, jobs: [job('/home/private')] })).toThrow('Invalid fleet snapshot');
  });
  it('bounds maximum input and rejects oversized or malformed snapshots without echoing them', () => {
    const input = snapshot({ lanes: Array.from({ length: 64 }, (_, i) => lane({ lane: `lane-${i}` })),
      jobs: Array.from({ length: 200 }, (_, i) => job(`J${i}`, { lane: `lane-${i % 64}` })),
      outcomes: Array.from({ length: 1000 }, (_, i) => outcome({ job: `J${i}`, lane: 'lane-0' })) });
    const plan = planChiefOfStaff(input);
    expect(plan.brief.text.length).toBeLessThanOrEqual(CHIEF_OF_STAFF_LIMITS.brief);
    expect(JSON.stringify(plan).length).toBeLessThan(150_000);
    expect(() => parseFleetSnapshot(snapshot({ jobs: [job('x'.repeat(1_000_000))] }))).toThrow('Invalid fleet snapshot');
    for (const bad of [null, { ...input, jobs: Array(201).fill(job('x')) }, snapshot({ jobs: [job('x'), job('x')] }), snapshot({ lanes: [lane({ target: NaN })] }), { ...input, at: '/Users/private' }]) {
      expect(() => parseFleetSnapshot(bad)).toThrow('Invalid fleet snapshot');
    }
  });
});

async function run(args: string[], files: Record<string, string>) {
  const out: string[] = [], err: string[] = [];
  const read = vi.fn(async (path: string) => { const text = files[path.replace('/capture/', '')]; if (text === undefined) throw new Error('/Users/private/unreadable'); return text; });
  const code = await cmdFleetChiefOfStaff(args, { read, runsDir: '/capture', now: () => new Date(at), out: t => out.push(t), err: t => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n'), read };
}
const capture = () => ({
  'queue/ready.tsv': 'RQ-A\tphantom\tcodex\twork\t/Users/private/prompt.md\nPARKED-DEP\tphantom\tcodex\twork\tignored',
  'queue/slots.json': JSON.stringify({ lanes: { codex: { target: 4, ceiling: 5, hard_cap: 5 } } }),
  'queue/resources.json': JSON.stringify({ codex: { used_frac: 0.2, reset_at: Date.parse(ago(-0.5)) / 1000 } }),
  'queue/status.json': JSON.stringify({ last_tick: at, paused: null, lanes: { codex: { held: false, running: 1 } } }),
  'metrics/jobs.jsonl': JSON.stringify({ event: 'finish', job: 'previous', lane: 'codex', ts: ago(1), exit_code: 0 }),
  'fleet/open-prs.json': JSON.stringify([{ lane: 'codex', mergeable: 'CONFLICTING' }]),
});
describe('chief-of-staff read-only CLI', () => {
  it('is reachable through the fleet registry and prints JSON or markdown', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['chief-of-staff']()).cmdFleetChiefOfStaff).toBe(cmdFleetChiefOfStaff);
    const files = { 'input.json': JSON.stringify(snapshot()) };
    const result = await run(['--snapshot', 'input.json', '--json'], files);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).schema).toBe('fleet.chief-of-staff.v1');
    expect((await run(['--snapshot', 'input.json', '--brief'], files)).out).toContain('# Fleet chief of staff');
  });
  it.each([['--apply'], ['--merge'], ['--json', '--brief'], ['--snapshot'], ['--snapshot', '--json'], ['--json', '--json']])('rejects unsupported flags before IO: %j', async (...args) => {
    const result = await run(args, {}); expect(result.code).toBe(2); expect(result.read).not.toHaveBeenCalled();
  });
  it('projects real dispatcher columns without reading prompt paths', async () => {
    const result = await run(['--snapshot', 'auto'], capture()), plan = JSON.parse(result.out);
    expect(result.code).toBe(0); expect(result.read).toHaveBeenCalledTimes(6);
    expect(plan.ordering.map((j: { job: string }) => j.job)).toEqual(['RQ-A']);
    expect(plan.inject[0].purpose).toBe('resolve-conflicts');
    expect(plan.sources['metrics/jobs.jsonl']).toBe('bounded');
    expect(result.out).not.toContain('/Users/private');
  });
  it.each([true, 'malformed'])('preserves a slot hold even when status says unheld: %j', async held => {
    const files = { ...capture(), 'queue/slots.json': JSON.stringify({ codex: { target: 4, ceiling: 5, held } }) };
    expect(JSON.parse((await run([], files)).out).ordering).toEqual([]);
  });
  it('reports unavailable or stale evidence without making unknown holds actionable', async () => {
    const missing = await run([], {}); expect(missing.code).toBe(1); expect(JSON.parse(missing.out).ordering).toEqual([]);
    const stale = await run([], { ...capture(), 'queue/status.json': JSON.stringify({ last_tick: ago(1), lanes: { codex: { held: false } } }) });
    expect(stale.code).toBe(1); expect(JSON.parse(stale.out).laneTargets[0].reason).toBe('hold-unknown');
    const broken = await run([], { ...capture(), 'queue/ready.tsv': 'bad' });
    expect(broken.code).toBe(1); expect(JSON.parse(broken.out).ordering).toEqual([]);
    const paused = await run([], { ...capture(), 'queue/status.json': JSON.stringify({ last_tick: at, paused: 'HOLD', lanes: { codex: { held: false } } }) });
    expect(JSON.parse(paused.out).ordering).toEqual([]);
    const unknown = await run([], { ...capture(), 'fleet/open-prs.json': '[]' });
    expect(JSON.parse(unknown.out).laneTargets[0]).toMatchObject({ recommended: 4, reason: 'evidence-incomplete' });
  });
  it('suppresses raw errors and refuses oversized files', async () => {
    for (const files of [{}, { 'input.json': 'x'.repeat(1024 * 1024 + 1) }, { 'input.json': '{' }]) {
      const result = await run(['--snapshot', 'input.json'], files);
      expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).toBe('chief-of-staff: snapshot unavailable or invalid');
    }
  });
});
