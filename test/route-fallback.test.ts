import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import './helpers/local-memory.js';
import { routeRequestSchema, type RouteRequest } from '../src/core/routing/decision-schema.js';
import { routeCandidateRejections } from '../src/core/routing/decision-candidates.js';
import { planFallbackChain, nextFailover, recordFailover, readFallbackUsed } from '../src/core/router/fallback.js';
import { cmdRoute } from '../src/cli/route.js';

const now = Date.parse('2026-11-17T12:00:00Z');
const lanes = ['a', 'b', 'c', 'd', 'e', 'codex-local'];
const request = (): RouteRequest => ({ job: 'job', repo: 'phantom', task_class: 'bug-fix', tier_hint: 'work',
  lane_candidates: lanes, quota_state: Object.fromEntries(lanes.map(l => [l, 'available' as const])),
  machine_state: { admit: true, running_by_lane: Object.fromEntries(lanes.map(l => [l, 0])) } });
const sources = () => ({ models: Object.fromEntries(lanes.map(l => [l, 'gpt-6.1-sol'])), admission: { admit: true },
  slots: Object.fromEntries(lanes.map(l => [l, { target: 1, hard_cap: 1, capabilities: ['git'], tiers: ['work'], cost_class: 'included', data_class: 'internal' }])),
  capacity: Object.fromEntries(lanes.map(l => [l, { resetAt: null as string | null, remainingPercent: 50 as number | null, observedAt: new Date(now).toISOString() }])) });

describe('provider-neutral fallback chains', () => {
  it('ranks at most three alternatives without primary or implicit local opt-in', () => {
    const plan = planFallbackChain(request(), sources(), 'a', now);
    expect(plan.lanes.map(e => e.lane)).toEqual(['b', 'c', 'd']);
    expect(plan).toMatchObject({ advisory: true, live: false, reason_codes: ['fallback_ranked', 'failover_dispatcher_unwired'] });
    expect(plan.rejected).toContainEqual({ lane: 'codex-local', reason_codes: ['local_opt_in_required'] });
  });

  it.each([
    ['capability', 'missing_capability'], ['minimum', 'tier_below_minimum'], ['tiers', 'tier_unavailable'],
    ['unknown-tier', 'tier_unknown'], ['cost', 'cost_class_exceeded'], ['unknown-cost', 'cost_class_unknown'],
    ['data', 'data_class_exceeded'], ['unknown', 'capacity_unknown'], ['missing-date', 'capacity_unknown'],
    ['stale', 'capacity_stale'], ['future', 'capacity_stale'], ['empty', 'capacity_exhausted'], ['reset', 'capacity_exhausted'],
    ['admission', 'admission_blocked'], ['quota', 'quota_unavailable'], ['slot', 'slot_invalid'],
    ['held', 'held'], ['running', 'running_unknown'], ['full', 'saturated'], ['model', 'model_invalid'],
    ['capacity-invalid', 'capacity_invalid'], ['mode', 'tier_inadequate'],
  ])('rejects %s with %s', (gate, code) => {
    const r = request(), s = sources();
    switch (gate) {
      case 'capability': r.needs = ['browser']; break;
      case 'minimum': r.min_tier = 'frontier'; break;
      case 'tiers': s.slots.b.tiers = ['fast']; break;
      case 'unknown-tier': delete (s.slots.b as Partial<typeof s.slots.b>).tiers; break;
      case 'cost': s.slots.b.cost_class = 'metered'; break;
      case 'unknown-cost': delete (s.slots.b as Partial<typeof s.slots.b>).cost_class; break;
      case 'data': r.data_class = 'restricted'; break;
      case 'unknown': s.capacity.b.remainingPercent = null; break;
      case 'missing-date': delete (s.capacity.b as Partial<typeof s.capacity.b>).observedAt; break;
      case 'stale': s.capacity.b.observedAt = new Date(now - 900001).toISOString(); break;
      case 'future': s.capacity.b.observedAt = new Date(now + 5001).toISOString(); break;
      case 'empty': s.capacity.b.remainingPercent = 0; break;
      case 'reset': s.capacity.b.resetAt = new Date(now).toISOString(); break;
      case 'admission': s.admission.admit = false; break;
      case 'quota': r.quota_state.b = 'exhausted'; break;
      case 'slot': s.slots.b.target = -1; break;
      case 'held': Object.assign(s.slots.b, { held: true }); break;
      case 'running': delete r.machine_state.running_by_lane.b; break;
      case 'full': r.machine_state.running_by_lane.b = 1; break;
      case 'model': s.models.b = '!'; break;
      case 'capacity-invalid': s.capacity.b.remainingPercent = -1; break;
      case 'mode': r.mode = 'ultra'; break;
    }
    expect(routeCandidateRejections(r, s, now, { failover: true }).find(e => e.lane === 'b')?.reason_codes).toContain(code);
    expect(planFallbackChain(r, s, 'a', now).lanes.some(e => e.lane === 'b')).toBe(false);
  });

  it('requires explicit metered ceiling and gates pins without losing order', () => {
    const r = request(), s = sources();
    r.fallback = [{ lane: 'd', on: ['timeout'] }, { lane: 'b', on: ['quota'] }, { lane: 'codex-local', on: ['quota'] }];
    s.slots.b.cost_class = 'metered';
    for (const ceiling of [undefined, 'included', 'metered'] as const) {
      r.max_cost_class = ceiling;
      expect(planFallbackChain(r, s, 'a', now).lanes.map(e => e.lane)).toEqual(ceiling === 'metered' ? ['d', 'b', 'codex-local'] : ['d', 'codex-local']);
    }
    const plan = planFallbackChain(r, s, 'a', now);
    expect(nextFailover(plan, { failed_lane: 'a', failure: 'quota', attempted: [] }).lane).toBe('b');
    expect(nextFailover(plan, { failed_lane: 'b', failure: 'quota', attempted: ['a', 'b'] }).lane).toBe('codex-local');
    expect(nextFailover(plan, { failed_lane: 'codex-local', failure: 'quota', attempted: ['b'] })).toMatchObject({ lane: null, reason_codes: ['fallback_chain_exhausted'] });
    expect(nextFailover(plan, { failed_lane: 'a', failure: 'other', attempted: [] })).toMatchObject({ lane: null, reason_codes: ['fallback_chain_exhausted', 'failure_unknown'] });
    s.capacity.b.remainingPercent = 0;
    expect(nextFailover(plan, { failed_lane: 'a', failure: 'quota', attempted: [] }, { request: r, sources: s, nowMs: now }).lane).toBe('codex-local');
    r.fallback = [];
    expect(planFallbackChain(r, s, 'a', now).reason_codes).toContain('fallback_chain_empty');
  });

  it('validates optional strict request fields and unique pins', () => {
    expect(routeRequestSchema.safeParse(request()).success).toBe(true);
    expect(routeRequestSchema.safeParse({ ...request(), surprise: true }).success).toBe(false);
    expect(routeRequestSchema.safeParse({ ...request(), needs: ['!'] }).success).toBe(false);
    expect(routeRequestSchema.safeParse({ ...request(), fallback: [{ lane: 'b', on: ['quota'] }, { lane: 'b', on: ['timeout'] }] }).success).toBe(false);
  });

  it('records sorted append-only receipts, bounds history and rejects symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fallback-'));
    try {
      expect(await readFallbackUsed(root, 'job')).toBeNull();
      for (const lane of ['b', 'c', 'd', null]) await recordFailover(root, { job: 'job', failed_lane: 'a', failure: 'quota', lane }, now);
      const rows = (await readFile(join(root, 'metrics/jobs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows[0]).toEqual({ event: 'failover', ts: now / 1000, job: 'job', lane: 'b', lane_hint: 'a', lane_override: 'failover_quota', failure: 'quota' });
      expect(Object.keys(rows[0])).toEqual(Object.keys(rows[0]).sort());
      expect((await readFallbackUsed(root, 'job'))?.map(r => r.lane)).toEqual(['c', 'd', null]);
      expect(rows[3]).toMatchObject({ event: 'failover_refused', reason_code: 'fallback_chain_exhausted' });
      await rm(join(root, 'metrics/jobs.jsonl'));
      await writeFile(join(root, 'other'), '');
      await symlink(join(root, 'other'), join(root, 'metrics/jobs.jsonl'));
      expect(await readFallbackUsed(root, 'job')).toBeNull();
      await expect(recordFailover(root, { job: 'job', failed_lane: 'a', failure: 'quota', lane: 'b' }, now)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prints failover JSON and records only when requested through CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fallback-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const s = sources();
      await mkdir(join(root, 'queue'));
      for (const [file, value] of Object.entries({ 'models.json': s.models, 'queue/slots.json': s.slots,
        'queue/admission.json': s.admission, 'queue/route-capacity.json': s.capacity, 'input.json': request() })) await writeFile(join(root, file), JSON.stringify(value));
      const args = ['failover', '--input', join(root, 'input.json'), '--failed-lane', 'a', '--failure', 'quota', '--root', root, '--json'];
      expect(await cmdRoute(args)).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ lane: 'b', reason_code: 'failover_quota', plan: { live: false } });
      expect(await readFallbackUsed(root, 'job')).toBeNull();
      expect(await cmdRoute([...args, '--record'])).toBe(0);
      expect(await readFallbackUsed(root, 'job')).toHaveLength(1);
      expect(await cmdRoute([...args, '--attempted', 'b,c,d,e'])).toBe(2);
    } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  });
});
