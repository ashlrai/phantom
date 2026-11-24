/**
 * RQ-RUNWAYN19BQ8: pool runway (usage/runway.ts), the router policy that keeps
 * filler off starving pools (routing/decision-candidates.ts) and `phm pool runway`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPool, runwayLine } from '../src/cli/pool.js';
import { capacityRunwayState, enumerateRouteCandidates, highYieldJob, loadRouteSources, rankRouteCandidates, routeCandidateRejections } from '../src/core/routing/decision-candidates.js';
import { decideRoute } from '../src/core/routing/decision.js';
import { anyPoolStarves, withRunwayYield } from '../src/core/queue/route-yield.js';
import type { RouteRequest } from '../src/core/routing/decision-schema.js';
import { POOL_RUNWAY_SCHEMA, RUNWAY_STATES, runway, runwayAdmits, type RunwaySnapshot } from '../src/core/usage/runway.js';
import { projectPoolRunway, readPoolRunway } from '../src/core/usage/runway-read.js';

// Nov 18, 07:00 ET: the morning the use-it-all pacer said "waste_risk low".
const now = Date.parse('2026-11-18T12:00:00Z');
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

describe('runway(pool)', () => {
  it('STARVE: Claude at 97% with 59 h to reset empties in hours and idles for days', () => {
    const row = runway({ pool: 'claude', usedPercent: 97, burnPerHour: 1.2, hoursToReset: 59 });
    expect(row).toMatchObject({ state: 'starve', hoursToEmpty: 2.5, hoursToReset: 59, idleHours: 56.5, unusedAtResetPercent: 0, safeBurnPerHour: 0.05, reason: null });
    expect(row.advice).toBe('runs out in 2h 30m, 2d 8h before reset: frontier and high-yield work only; slow to 0.05%/h');
  });

  it('STARVE: a used-up pool idles until reset', () => {
    expect(runway({ pool: 'codex-personal', usedPercent: 100, burnPerHour: null, hoursToReset: 81 }))
      .toMatchObject({ state: 'starve', hoursToEmpty: 0, idleHours: 81, advice: expect.stringContaining('send nothing new here') });
  });

  it('SPEND: resets with usage left, including a pool nothing is using', () => {
    expect(runway({ pool: 'zai', usedPercent: 20, burnPerHour: 0.2, hoursToReset: 100 }))
      .toMatchObject({ state: 'spend', hoursToEmpty: 400, unusedAtResetPercent: 60, idleHours: null, advice: '60% would go unused at reset: send filler here' });
    expect(runway({ pool: 'grok', usedPercent: 10, burnPerHour: 0, hoursToReset: 30 }))
      .toMatchObject({ state: 'spend', hoursToEmpty: null, unusedAtResetPercent: 90, advice: 'nothing is using it; 90% left: send filler here' });
  });

  it('PACE: lands within the spare margin at reset without a long idle gap', () => {
    expect(runway({ pool: 'claude', usedPercent: 50, burnPerHour: 1, hoursToReset: 49 }))
      .toMatchObject({ state: 'pace', hoursToEmpty: 50, unusedAtResetPercent: 1, advice: 'on track to use it all by reset' });
    // Empties 2 h early out of 100 h: under the 5% idle share, still on pace.
    expect(runway({ pool: 'claude', usedPercent: 2, burnPerHour: 1, hoursToReset: 100 }).state).toBe('pace');
  });

  it('unknown burn shows unknown and never guesses a state or an empty time', () => {
    const row = runway({ pool: 'claude', usedPercent: 97, burnPerHour: null, hoursToReset: 59 });
    expect(row).toMatchObject({ state: 'unknown', usedPercent: 97, hoursToReset: 59, burnPerHour: null, hoursToEmpty: null,
      idleHours: null, unusedAtResetPercent: null, reason: 'no burn rate yet', advice: 'unknown: no burn rate yet' });
    expect(runway({ pool: 'x', usedPercent: null, burnPerHour: 1, hoursToReset: 5 })).toMatchObject({ state: 'unknown', reason: 'no usage reading' });
    expect(runway({ pool: 'x', usedPercent: 10, burnPerHour: 1, hoursToReset: -2 })).toMatchObject({ state: 'unknown', reason: 'reset time unknown', hoursToReset: null });
    expect(runway({ pool: 'x', usedPercent: 10, burnPerHour: Number.NaN, hoursToReset: 5 }).state).toBe('unknown');
  });

  it('admits frontier and high-yield work to a starving pool, and anything elsewhere', () => {
    expect(runwayAdmits('starve', 'frontier', false)).toBe(true);
    expect(runwayAdmits('starve', 'mid', true)).toBe(true);
    expect(runwayAdmits('starve', 'mid', false)).toBe(false);
    expect(runwayAdmits('starve', 'work', false)).toBe(false);
    for (const state of ['spend', 'pace', 'unknown'] as const) expect(runwayAdmits(state, 'fast', false)).toBe(true);
  });
});

describe('projectPoolRunway over the dispatchd status ledger', () => {
  const status = (budget: Record<string, unknown>, tick = now - 30_000) => ({ schema: 'dispatchd.status.v1', last_tick: new Date(tick).toISOString(), budget });
  const uia = (fields: Record<string, unknown>) => ({ use_it_all: { known: true, stale: false, ...fields } });

  it('orders starve (longest idle) first, then spend, pace and unknown, with one headline', () => {
    const snap = projectPoolRunway(status({
      claude: uia({ used_pct: 97, burn_pct_per_hour: 1.2, reset_at: at(59) }),
      'codex-personal': uia({ used_pct: 93, burn_pct_per_hour: 1, reset_at: at(81) }),
      zai: uia({ used_pct: 20, burn_pct_per_hour: 0.2, reset_at: at(100) }),
      gemini: uia({ used_pct: 50, burn_pct_per_hour: 1, hours_to_reset: 49 }),
      grok: uia({ used_pct: 40, reset_at: at(30) }),
    }), now);
    expect(snap.schema).toBe(POOL_RUNWAY_SCHEMA);
    expect(snap.asOf).toBe(new Date(now - 30_000).toISOString());
    expect(snap.pools.map(row => [row.pool, row.state])).toEqual([
      ['codex-personal', 'starve'], ['claude', 'starve'], ['zai', 'spend'], ['gemini', 'pace'], ['grok', 'unknown']]);
    expect(snap.headline).toBe('Codex-personal runs out 3d 2h early, claude runs out 2d 8h early: frontier work only there; send filler to zai; 1 unknown.');
  });

  it('reads stale or missing status as unknown for the core pools', () => {
    for (const raw of [null, status({}, now - 10 * 60_000), { schema: 'other' }]) {
      const snap = projectPoolRunway(raw, now);
      expect(snap.pools.map(row => row.pool)).toEqual(['claude', 'codex-personal', 'gemini', 'zai']);
      expect(snap.pools.every(row => row.state === 'unknown' && row.reason === 'status missing or stale')).toBe(true);
      expect(snap.headline).toBe('Unknown: the dispatcher status is missing or stale.');
    }
    expect(projectPoolRunway(status({ claude: { use_it_all: { known: true, stale: true, used_pct: 10 } } }), now).pools[0])
      .toMatchObject({ pool: 'claude', state: 'unknown', reason: 'reading stale', usedPercent: null });
  });

  it('readPoolRunway reads queue/status.json and degrades to unknown when it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runway-'));
    try {
      const path = join(dir, 'status.json');
      expect((await readPoolRunway(path, now)).pools.every(row => row.state === 'unknown')).toBe(true);
      await writeFile(path, JSON.stringify(status({ claude: uia({ used_pct: 97, burn_pct_per_hour: 1.2, reset_at: at(59) }) })));
      expect((await readPoolRunway(path, now)).pools[0]).toMatchObject({ pool: 'claude', state: 'starve' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('router: runway policy', () => {
  // claude: 3% left, 59 h to reset, burning 1.2%/h -> starve. zai: 80% left, 100 h, 0.2%/h -> spend.
  const sources = (claudeBurn: number | null = 1.2) => ({
    models: { claude: 'claude-fable-5-2', zai: 'gpt-6-astra' },
    slots: { claude: { target: 2, hard_cap: 2 }, zai: { target: 2, hard_cap: 2 } },
    admission: { admit: true },
    capacity: { claude: { resetAt: at(59), remainingPercent: 3, burnPerHour: claudeBurn },
      zai: { resetAt: at(100), remainingPercent: 80, burnPerHour: 0.2 } },
  });
  const request = (tier: RouteRequest['tier_hint'], job = 'RQ-PHX-RECUTCOREC541'): RouteRequest => ({
    task_class: 'bug-fix', repo: 'phantom', tier_hint: tier, job, lane_candidates: ['claude', 'zai'],
    quota_state: { claude: 'available', zai: 'available' }, machine_state: { admit: true, running_by_lane: { claude: 0, zai: 0 } } });

  it('sends a mid-tier filler job away from a STARVE pool and keeps a frontier job on it', async () => {
    expect(capacityRunwayState({ pool: 'claude', ...sources().capacity.claude }, now)).toBe('starve');
    const mid = await decideRoute(request('mid'), sources(), { backends: [], nowMs: now });
    expect(mid).toMatchObject({ lane: 'zai' });
    const frontier = await decideRoute(request('frontier'), sources(), { backends: [], nowMs: now });
    // Frontier keeps the nearest reset: the starving Claude pool.
    expect(frontier).toMatchObject({ lane: 'claude' });
    expect(rankRouteCandidates(request('mid'), enumerateRouteCandidates(request('mid'), sources()), now).map(c => c.lane)).toEqual(['zai']);
  });

  it('lets a high-yield job kind use the starving pool, but filler still prefers a SPEND pool first', () => {
    const familyYield = { 'RQ-PHX-RECUTCORE': 0.5, 'RQ-LOWYIELD': 0.05 };
    expect(highYieldJob(request('mid'), familyYield)).toBe(true);
    expect(highYieldJob(request('mid', 'RQ-LOWYIELDC12'), familyYield)).toBe(false);
    expect(highYieldJob(request('mid', 'RQ-NEWKINDC1'), familyYield)).toBe(false);
    const ranked = rankRouteCandidates(request('mid'), enumerateRouteCandidates(request('mid'), sources()), now, familyYield);
    expect(ranked.map(c => c.lane)).toEqual(['zai', 'claude']);
  });

  it('never bars a pool whose burn rate is unknown; with no measured runway the reset order stands', () => {
    // Claude unknown, zai still a measured SPEND pool: Claude stays eligible, filler prefers zai.
    const ranked = rankRouteCandidates(request('mid'), enumerateRouteCandidates(request('mid'), sources(null)), now);
    expect(ranked.map(c => c.lane)).toEqual(['zai', 'claude']);
    const unmeasured = sources(null);
    unmeasured.capacity.zai.burnPerHour = null as unknown as number;
    expect(rankRouteCandidates(request('mid'), enumerateRouteCandidates(request('mid'), unmeasured), now).map(c => c.lane)).toEqual(['claude', 'zai']);
  });

  it('names runway_starve in the eligibility report for filler only', () => {
    const reasons = (tier: RouteRequest['tier_hint']) => routeCandidateRejections(request(tier), sources(), now).find(r => r.lane === 'claude')!.reason_codes;
    expect(reasons('fast')).toContain('runway_starve');
    expect(reasons('frontier')).not.toContain('runway_starve');
    expect(routeCandidateRejections(request('fast'), sources(), now).find(r => r.lane === 'zai')!.reason_codes).toEqual([]);
    // A used-up window belongs to the exhaustion rule alone.
    const spent = sources();
    spent.capacity.claude.remainingPercent = 0;
    expect(routeCandidateRejections(request('fast'), spent, now).find(r => r.lane === 'claude')!.reason_codes).toEqual(['capacity_exhausted']);
  });

  it('withRunwayYield reads job yield only when a pool starves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runway-route-'));
    try {
      await mkdir(join(root, 'queue'), { recursive: true });
      await mkdir(join(root, 'metrics'), { recursive: true });
      const spare = { zai: { resetAt: new Date(Date.now() + 100 * 3_600_000).toISOString(), remainingPercent: 80, burnPerHour: 0.2 } };
      await writeFile(join(root, 'queue', 'route-capacity.json'), JSON.stringify(spare));
      expect(anyPoolStarves(spare, Date.now())).toBe(false);
      expect((await withRunwayYield(root, await loadRouteSources(root))).familyYield).toBeUndefined();
      await writeFile(join(root, 'queue', 'route-capacity.json'), JSON.stringify({ ...spare,
        claude: { resetAt: new Date(Date.now() + 59 * 3_600_000).toISOString(), remainingPercent: 3, burnPerHour: 1.2 } }));
      const ts = new Date(Date.now() - 3_600_000).toISOString();
      const rows = [1, 2].flatMap(n => [
        { event: 'launch', job: `RQ-PHX-RECUTCOREC${n}`, repo: 'phantom', lane: 'claude', tier: 'mid', ts },
        { event: 'pr', job: `RQ-PHX-RECUTCOREC${n}`, pr: `https://github.com/ashlrai/phantom/pull/${n}`, ts },
        { event: 'outcome', job: `RQ-PHX-RECUTCOREC${n}`, state: 'MERGED', ts },
      ]);
      await writeFile(join(root, 'metrics', 'jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const loaded = await withRunwayYield(root, await loadRouteSources(root));
      expect(loaded.familyYield).toEqual(expect.any(Object));
      // Plain route sources never read the job ledger.
      expect((await loadRouteSources(root)).familyYield).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe('phm pool runway', () => {
  afterEach(() => vi.restoreAllMocks());
  const snapshot = (): RunwaySnapshot => projectPoolRunway({ schema: 'dispatchd.status.v1', last_tick: new Date(now - 1000).toISOString(), budget: {
    claude: { use_it_all: { known: true, stale: false, used_pct: 97, burn_pct_per_hour: 1.2, reset_at: at(59) } },
    zai: { use_it_all: { known: true, stale: false, used_pct: 20, burn_pct_per_hour: 0, reset_at: at(100) } },
  } }, now);
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { out.push(String(line)); });
    return out;
  };

  it('--json prints pool.runway.v1 with one typed row per pool', async () => {
    const out = capture();
    expect(await cmdPool(['runway', '--json'], { readRunway: async () => snapshot() })).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['asOf', 'headline', 'pools', 'schema', 'shares', 'v']);
    expect(parsed).toMatchObject({ schema: 'pool.runway.v1', v: 1, asOf: expect.any(String), headline: expect.any(String) });
    const pools = parsed.pools as Record<string, unknown>[];
    expect(pools.length).toBe(4);
    for (const row of pools) {
      expect(Object.keys(row).sort()).toEqual(['advice', 'burnPerHour', 'hoursToEmpty', 'hoursToReset', 'idleHours', 'pool', 'reason',
        'safeBurnPerHour', 'state', 'unusedAtResetPercent', 'usedPercent']);
      expect(RUNWAY_STATES).toContain(row.state);
      expect(typeof row.pool === 'string' && typeof row.advice === 'string').toBe(true);
      for (const key of ['usedPercent', 'burnPerHour', 'hoursToEmpty', 'hoursToReset', 'idleHours', 'unusedAtResetPercent', 'safeBurnPerHour']) {
        expect(row[key] === null || typeof row[key] === 'number').toBe(true);
      }
    }
    expect(pools[0]).toMatchObject({ pool: 'claude', state: 'starve', usedPercent: 97, burnPerHour: 1.2, hoursToEmpty: 2.5, hoursToReset: 59 });
  });

  it('prints the headline then one plain line per pool', async () => {
    const out = capture();
    expect(await cmdPool(['runway'], { readRunway: async () => snapshot() })).toBe(0);
    expect(out[0]).toBe(snapshot().headline);
    expect(out[1]).toBe('claude: STARVE · 97% used · burn 1.2%/h · empty in 2.5h · reset in 59h · runs out in 2h 30m, 2d 8h before reset: frontier and high-yield work only; slow to 0.05%/h');
    expect(out[2]).toContain('zai: SPEND · 20% used · burn 0%/h · empty in never at this rate');
    expect(out.slice(3).every(line => line.includes('UNKNOWN') && line.includes('unknown'))).toBe(true);
  });

  it('shows usage on help and refuses unknown arguments', async () => {
    const out = capture();
    expect(await cmdPool(['runway', '--help'])).toBe(0);
    expect(out.join('\n')).toContain('phm pool runway [--json]');
    expect(await cmdPool(['runway', '--hours'])).toBe(2);
    expect(await cmdPool(['runway', '--json', '--json'])).toBe(2);
    expect(runwayLine(snapshot().pools[0]!)).toMatch(/^claude: STARVE/);
  });
});
