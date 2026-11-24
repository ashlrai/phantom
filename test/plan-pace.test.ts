import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { poolUsageSeries, type UsageReading } from '../src/core/fleet/usage-history.js';
import {
  PACE_ALERT_GAP_MS, paceAlertLine, paceVerdict, planPaceAlerts, planPaceRows, postPaceAlerts, type PlanPaceRow,
} from '../src/core/usage/plan-pace.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const H = 3_600_000;
const iso = (t: number): string => new Date(t).toISOString();
const reading = (pool: string, hoursAgo: number, used: number, resetInH: number): UsageReading =>
  ({ pool, used_pct: used, observed_at: iso(NOW - hoursAgo * H), reset_at: iso(NOW + resetInH * H), source: null });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const row = (over: Partial<PlanPaceRow>): PlanPaceRow => ({
  plan: 'claude', used_percent: 40, hours_to_reset: 40, points_per_hour: 7, even_pace_points_per_hour: 1.5, hours_early: 31.4,
  unspent_percent: 0, runs_out_in_hours: 8.6, verdict: 'too fast', reason: null, ...over,
});

describe('paceVerdict thresholds', () => {
  it('too fast starts at 6 hours early', () => {
    expect(paceVerdict(5.9, 0)).toBe('on pace');
    expect(paceVerdict(6, 0)).toBe('too fast');
    expect(paceVerdict(30, 0)).toBe('too fast');
  });
  it('too slow is more than 15% unspent', () => {
    expect(paceVerdict(-20, 15)).toBe('on pace');
    expect(paceVerdict(-20, 15.1)).toBe('too slow');
  });
  it('unknown stays unknown', () => {
    expect(paceVerdict(null, null)).toBe('unknown');
    expect(paceVerdict(10, null)).toBe('unknown');
  });
});

describe('planPaceRows (numbers from the runway report)', () => {
  it('claude at 40% with 7 points an hour and 40 h left runs out about 31 h early', () => {
    // 7 points an hour: 33% at -3h, 40% now. Left 60 -> empty in 8.6 h.
    const rows = [reading('claude', 3, 33, 40), reading('claude', 0.5, 36.5, 40), reading('claude', 0, 40, 40)];
    const [r] = planPaceRows([poolUsageSeries('claude', rows, NOW)]);
    expect(r).toMatchObject({ plan: 'claude', used_percent: 40, hours_to_reset: 40, verdict: 'too fast' });
    expect(r!.points_per_hour).toBeGreaterThan(6);
    expect(r!.hours_early).toBeGreaterThan(6);
    expect(r!.even_pace_points_per_hour).toBe(1.5);
  });
  it('a slow plan is too slow with the unspent share', () => {
    const [r] = planPaceRows([poolUsageSeries('zai', [reading('zai', 3, 20, 45), reading('zai', 1, 21, 45)], NOW)]);
    expect(r).toMatchObject({ verdict: 'too slow', points_per_hour: 0.5, unspent_percent: 56.5 });
    expect(r!.hours_early).toBeLessThan(0);
  });
  it('a single reading is unknown with a reason, nulls and no verdict guess', () => {
    const [r] = planPaceRows([poolUsageSeries('gemini', [reading('gemini', 1, 30, 40)], NOW)]);
    expect(r).toMatchObject({ verdict: 'unknown', points_per_hour: null, hours_early: null, unspent_percent: null, reason: 'only one reading' });
  });
});

describe('alert lines', () => {
  it('too fast names the rate, the run-out time and the hours early', () => {
    expect(paceAlertLine(row({}), NOW, 'UTC')).toBe(
      'Claude is burning 7 points an hour; at this rate it runs out Wednesday 8 PM, 31 hours before its reset.');
  });
  it('too slow says how much goes unused and the even pace', () => {
    expect(paceAlertLine(row({ verdict: 'too slow', points_per_hour: 0.5, unspent_percent: 56.5, hours_early: -20, even_pace_points_per_hour: 1.76 }), NOW))
      .toBe('Claude is burning only 0.5 points an hour; at this rate 57% goes unused at its reset. Speed up to 1.8 points an hour to use it all.');
  });
  it('on pace and unknown say nothing', () => {
    expect(paceAlertLine(row({ verdict: 'on pace' }), NOW)).toBeNull();
    expect(paceAlertLine(row({ verdict: 'unknown' }), NOW)).toBeNull();
  });
});

describe('2-hour de-duplication', () => {
  it('posts once, then stays quiet for 2 hours, then posts again', () => {
    const rows = [row({}), row({ plan: 'zai', verdict: 'on pace' })];
    const first = planPaceAlerts(rows, {}, NOW);
    expect(first.posts.map(p => p.plan)).toEqual(['claude']);
    expect(planPaceAlerts(rows, first.state, NOW + PACE_ALERT_GAP_MS - 1).posts).toEqual([]);
    expect(planPaceAlerts(rows, first.state, NOW + PACE_ALERT_GAP_MS).posts.map(p => p.plan)).toEqual(['claude']);
  });
  it('is per plan, and a verdict change inside the window still waits', () => {
    const first = planPaceAlerts([row({})], {}, NOW);
    const later = planPaceAlerts([row({ verdict: 'too slow', points_per_hour: 0.5, unspent_percent: 30 }), row({ plan: 'zai' })], first.state, NOW + H);
    expect(later.posts.map(p => p.plan)).toEqual(['zai']);
  });
  it('persists through the state file; a failed post is retried next tick', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pace-'));
    dirs.push(stateDir);
    const lines: string[] = [];
    const deps = { stateDir, post: (t: string) => { lines.push(t); } };
    expect(await postPaceAlerts([row({})], deps, NOW, 'UTC')).toHaveLength(1);
    expect(await postPaceAlerts([row({})], deps, NOW + H, 'UTC')).toEqual([]);
    expect(await postPaceAlerts([row({})], deps, NOW + 2 * H, 'UTC')).toHaveLength(1);
    expect(lines).toHaveLength(2);
    const failing = { stateDir, post: () => { throw new Error('down'); } };
    expect(await postPaceAlerts([row({ plan: 'gemini' })], failing, NOW)).toEqual([]);
    expect(await postPaceAlerts([row({ plan: 'gemini' })], deps, NOW + 1000, 'UTC')).toHaveLength(1);
  });
});
