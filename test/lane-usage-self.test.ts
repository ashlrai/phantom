import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  budgetEntryQuota, calibrate, consumed, estimateLane, needsRead, refreshLanes, zaiCredits, zaiWeekStart,
  type JobRow, type LaneState,
} from '../src/core/fabric/lane-usage-self.js';
import { runSelfRefresh } from '../src/core/fabric/lane-usage-self-io.js';
import { decideLane } from '../src/core/resources/lane-autopilot.js';

const T0 = Date.parse('2026-11-10T12:00:00Z'); // a Tuesday
const fin = (lane: string, ts: string, extra: Record<string, unknown>): JobRow => ({ event: 'finish', lane, ts, ...extra });

describe('needsRead', () => {
  it('re-reads missing, estimated, stale and past-reset entries', () => {
    const fresh = { as_of: new Date(T0 - 60_000).toISOString(), reset_at: new Date(T0 + 3_600_000).toISOString(), estimated: false };
    expect(needsRead(fresh as never, T0)).toBe(false);
    expect(needsRead(undefined, T0)).toBe(true);
    expect(needsRead({ ...fresh, estimated: true } as never, T0)).toBe(true);
    expect(needsRead({ ...fresh, as_of: new Date(T0 - 2 * 3_600_000).toISOString() } as never, T0)).toBe(true);
    expect(needsRead({ ...fresh, reset_at: new Date(T0 - 1000).toISOString() } as never, T0)).toBe(true);
    expect(needsRead({ ...fresh, as_of: 'garbage' } as never, T0)).toBe(true);
  });
});

describe('zai schedule estimate', () => {
  it('week starts Monday 00:00 UTC and credits follow docs/lanes/zai.md', () => {
    expect(new Date(zaiWeekStart(T0)).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(zaiCredits({ tokens_in: 10_000, tokens_out: 1000, tokens_cache_read: 0 })).toBeCloseTo((10_000 * 6.9 + 1000 * 24) / 10_000);
    expect(zaiCredits({ tier: 'fast', tokens_in: 1000, tokens_out: 1000, tokens_cache_read: 500 })).toBeCloseTo((500 * 2.3 + 500 * 0.56 + 8000) / 1000);
    expect(zaiCredits({ tokens_out: 5 })).toBeNull();
  });
  it('estimates used percent from this week only, with next Monday as reset', () => {
    const rows = [
      fin('zai', '2026-11-08T23:00:00', { tokens_in: 1_000_000, tokens_out: 1_000_000 }), // last week, ignored
      fin('zai', '2026-11-10T01:00:00', { tokens_in: 100_000, tokens_out: 10_000 }),
      fin('zai', '2026-11-10T02:00:00', { tokens_in: null }),
    ];
    const e = estimateLane('zai', undefined, rows, T0)!;
    const used = (100_000 * 6.9 + 10_000 * 24) / 10_000;
    expect(e.estimated).toBe(true);
    expect(e.weekly_used_pct).toBeCloseTo(used / 100, 1);
    expect(e.reset_at).toBe('2026-11-16T00:00:00.000Z');
    expect(e.unmeasured_jobs).toBe(1);
  });
});

describe('rolling estimate for claude', () => {
  const reading = { pctUsed: 40, resetAt: new Date(T0 + 2 * 86_400_000).toISOString(), source: 'claude-usage-reading' };
  const rows = [fin('claude', '2026-11-09T12:00:00', { tokens_total: 4_000_000 }), fin('claude', '2026-11-10T12:30:00', { tokens_total: 1_000_000 })];
  it('calibrates units per percent from the reading and adds later accounting', () => {
    const st = calibrate('claude', reading, rows.slice(0, 1), T0)!;
    expect(st.unitsPerPct).toBe(100_000);
    const later = estimateLane('claude', st, rows, T0 + 3_600_000)!;
    expect(later.weekly_used_pct).toBe(50);
    expect(later.estimated).toBe(true);
  });
  it('rolls a passed reset forward by one week and counts only new-window usage', () => {
    const st: LaneState = { asOf: new Date(T0).toISOString(), pctUsed: 90, resetAt: new Date(T0 + 3_600_000).toISOString(), unitsPerPct: 100_000, limit: null };
    const now = T0 + 2 * 3_600_000;
    const r = [fin('claude', new Date(T0 + 1_800_000).toISOString().slice(0, 19), { tokens_total: 9_999_999 }),
      fin('claude', new Date(T0 + 3_700_000).toISOString().slice(0, 19), { tokens_total: 500_000 })];
    const e = estimateLane('claude', st, r, now)!;
    expect(e.reset_at).toBe(new Date(T0 + 3_600_000 + 7 * 86_400_000).toISOString());
    expect(e.weekly_used_pct).toBe(5);
  });
  it('has no estimate without a calibration, and unknown pct when units are unknown', () => {
    expect(estimateLane('claude', undefined, rows, T0)).toBeNull();
    const st: LaneState = { asOf: new Date(T0 - 1000).toISOString(), pctUsed: 3, resetAt: null, unitsPerPct: null, limit: null };
    expect(estimateLane('claude', st, rows, T0 + 3_600_000)!.weekly_used_pct).toBeNull();
  });
  it('gemini and omlx never get an invented estimate', () => {
    expect(estimateLane('gemini', undefined, rows, T0)).toBeNull();
    expect(estimateLane('omlx', undefined, rows, T0)).toBeNull();
  });
});

describe('devin ACUs', () => {
  it('uses the reported limit and ACU accounting; reset unknown after it passes', () => {
    const reading = { pctUsed: 50, resetAt: new Date(T0 + 86_400_000).toISOString(), limit: 1000, creditsRemaining: 500, source: 'devin-api-v3-org-cycle' };
    const st = calibrate('devin', reading, [], T0)!;
    expect(st.unitsPerPct).toBe(10);
    const e = estimateLane('devin', st, [fin('devin', new Date(T0 + 60_000).toISOString().slice(0, 19), { acus: 100 })], T0 + 3_600_000)!;
    expect(e.weekly_used_pct).toBe(60);
    expect(e.credits_remaining).toBe(400);
    const after = estimateLane('devin', st, [], T0 + 2 * 86_400_000)!;
    expect(after.reset_at).toBeNull();
    expect(after.weekly_used_pct).toBe(0);
  });
});

describe('refreshLanes', () => {
  const base = { rows: [] as JobRow[], nowMs: T0, state: {} };
  it('prefers a sanctioned reading and preserves unrelated fields', async () => {
    const r = await refreshLanes({ ...base, lanes: ['devin'], overrides: { devin: { allowance: { acus: 5 } }, compact: { l1_free_gb: 1 } },
      readers: { devin: async () => ({ pctUsed: 25, resetAt: new Date(T0 + 86_400_000).toISOString(), limit: 400, creditsRemaining: 300, source: 'devin-api-v3-org-cycle' }) } });
    const d = r.overrides['devin'] as Record<string, unknown>;
    expect(d).toMatchObject({ weekly_used_pct: 25, credits_remaining: 300, estimated: false, source: 'devin-api-v3-org-cycle', allowance: { acus: 5 } });
    expect(r.overrides['compact']).toEqual({ l1_free_gb: 1 });
    expect(r.state.devin?.unitsPerPct).toBe(4);
  });
  it('keeps a fresh typed reading from any writer', async () => {
    const typed = { weekly_used_pct: 70, reset_at: new Date(T0 + 86_400_000).toISOString(), source: 'bot', estimated: false, as_of: new Date(T0 - 60_000).toISOString() };
    const r = await refreshLanes({ ...base, lanes: ['claude'], overrides: { claude: typed }, readers: { claude: async () => { throw new Error('must not run'); } } });
    expect(r.outcomes[0]!.action).toBe('kept');
  });
  it('falls back to an estimate when the reader fails and re-reads after reset_at', async () => {
    const st: LaneState = { asOf: new Date(T0 - 3_600_000).toISOString(), pctUsed: 10, resetAt: new Date(T0 - 1000).toISOString(), unitsPerPct: 1000, limit: null };
    const old = { weekly_used_pct: 10, reset_at: st.resetAt, source: 'x', estimated: false, as_of: new Date(T0 - 3_600_000).toISOString() };
    let calls = 0;
    const r = await refreshLanes({ ...base, state: { claude: st }, lanes: ['claude'], overrides: { claude: old },
      readers: { claude: async () => { calls++; throw new Error('boom'); } } });
    expect(calls).toBe(1);
    expect(r.outcomes[0]!.action).toBe('estimated');
    expect((r.overrides['claude'] as { estimated: boolean }).estimated).toBe(true);
  });
  it('ignores a reading whose reset already passed and never emits ask-for-reading text', async () => {
    const r = await refreshLanes({ ...base, lanes: ['gemini', 'claude'], overrides: {},
      readers: { claude: async () => ({ pctUsed: 5, resetAt: new Date(T0 - 5).toISOString(), source: 's' }) } });
    expect(r.outcomes.map(o => o.action)).toEqual(['unknown', 'unknown']);
    expect(JSON.stringify(r)).not.toMatch(/ask|human|Mason/i);
    expect((r.overrides['gemini'] as { weekly_used_pct: unknown }).weekly_used_pct).toBeNull();
  });
  it('reports oMLX capacity with no percent and no reset', async () => {
    const r = await refreshLanes({ ...base, lanes: ['omlx'], overrides: {},
      readers: { omlx: async () => ({ pctUsed: null, resetAt: null, creditsRemaining: 3, source: 'omlx-loopback-models' }) } });
    expect(r.overrides['omlx']).toMatchObject({ weekly_used_pct: null, credits_remaining: 3, reset_at: null, estimated: false });
  });
});

describe('autopilot consumption', () => {
  it('an estimated entry yields a pace target instead of holding', () => {
    const entry = { weekly_used_pct: 50, as_of: new Date(T0 - 60_000).toISOString(), estimated: true };
    const quota = budgetEntryQuota(entry, T0);
    const d = decideLane({ lane: 'claude', kind: 'quota-window', limits: { target: 4, floor: 1, ceiling: 8 }, quota }, 'green', T0);
    expect(d.held).toBe(false);
    expect(budgetEntryQuota({ weekly_used_pct: null, as_of: entry.as_of }, T0).value).toBeNull();
    expect(budgetEntryQuota({ weekly_used_pct: 5, as_of: 'x' }, T0).value).toBeNull();
  });
});

describe('runSelfRefresh', () => {
  it('writes budget-overrides.json atomically, keeping other keys, and honours dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-self-'));
    mkdirSync(join(dir, 'queue')); mkdirSync(join(dir, 'metrics'));
    writeFileSync(join(dir, 'queue', 'budget-overrides.json'), JSON.stringify({ compact: { l1_free_gb: 9 } }));
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), JSON.stringify(fin('zai', '2026-11-10T01:00:00', { tokens_in: 100_000, tokens_out: 10_000 })) + '\nnot json\n');
    const opts = { runsDir: dir, nowMs: () => T0, lanes: ['zai', 'gemini'] as const, readers: {} };
    await runSelfRefresh({ ...opts, dryRun: true });
    expect(JSON.parse(readFileSync(join(dir, 'queue', 'budget-overrides.json'), 'utf8'))).toEqual({ compact: { l1_free_gb: 9 } });
    await runSelfRefresh(opts);
    const out = JSON.parse(readFileSync(join(dir, 'queue', 'budget-overrides.json'), 'utf8'));
    expect(out.compact).toEqual({ l1_free_gb: 9 });
    expect(out.zai).toMatchObject({ estimated: true, reset_at: '2026-11-16T00:00:00.000Z' });
    expect(out.gemini.weekly_used_pct).toBeNull();
    expect(consumed('zai', [], 0, 1)).toEqual({ units: 0, unmeasured: 0 });
  });
});
