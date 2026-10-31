import { describe, expect, it } from 'vitest';
import { decideLane, devinStepDown, diskLevel, fresh, GIB, TYPED_MAX_AGE_MS, type LaneInput } from '../src/core/resources/lane-autopilot.js';
import { anthropicBalanceReading, cloudCreditReading, codexQuotaReading, devinAllowanceReading } from '../src/core/resources/credit-pool-observations.js';

const NOW = Date.parse('2026-10-27T03:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const disk = (gb: number, inodePct = 50) => ({ freeBytes: gb * GIB, totalBytes: 128 * GIB, freeInodes: inodePct * 1000, totalInodes: 100_000 });
const codex = (used: number | null, asOf: string | null = ago(60_000)): LaneInput => ({ lane: 'codex-cmp', kind: 'quota-window',
  limits: { target: 10, floor: 10, ceiling: 32 }, quota: { value: used === null ? null : { usedPercent: used }, asOf, ttlMs: 30 * 60_000 } });

describe('disk levels (bytes and inodes)', () => {
  it('maps thresholds', () => {
    expect(diskLevel(disk(42))).toBe('green');
    expect(diskLevel(disk(39))).toBe('compact1');
    expect(diskLevel(disk(27))).toBe('compact2');
    expect(diskLevel(disk(17))).toBe('pause');
    expect(diskLevel(disk(100, 15))).toBe('compact1');
    expect(diskLevel(disk(100, 10))).toBe('compact2');
    expect(diskLevel(disk(100, 4))).toBe('pause');
  });
});

describe('lane decisions', () => {
  it('clamps to floor and ceiling', () => {
    expect(decideLane(codex(0), 'green', NOW).target).toBe(32);
    expect(decideLane(codex(50), 'green', NOW).target).toBe(21);
  });
  it('codex at 90% used drops to floor', () => {
    expect(decideLane(codex(90), 'green', NOW).target).toBe(10);
  });
  it('unknown reading holds and never raises', () => {
    const d = decideLane(codex(null), 'green', NOW);
    expect(d).toMatchObject({ target: 10, held: true });
  });
  it('stale reading holds', () => {
    expect(decideLane(codex(0, ago(31 * 60_000)), 'green', NOW).held).toBe(true);
  });
  it('typed value older than 24h is unknown even with a long ttl', () => {
    expect(fresh({ value: 1, asOf: ago(TYPED_MAX_AGE_MS + 1000), ttlMs: 7 * TYPED_MAX_AGE_MS }, NOW)).toBe(false);
    expect(fresh({ value: 1, asOf: ago(TYPED_MAX_AGE_MS - 1000), ttlMs: TYPED_MAX_AGE_MS }, NOW)).toBe(true);
  });
  it('missing as_of is unknown', () => {
    expect(fresh({ value: 1, asOf: null, ttlMs: TYPED_MAX_AGE_MS }, NOW)).toBe(false);
  });
  it('compact1 freezes raises, compact2 halves, pause stops launches', () => {
    expect(decideLane(codex(0), 'compact1', NOW).target).toBe(10);
    const api: LaneInput = { lane: 'claude-api', kind: 'usd-paced', limits: { target: 6, floor: 0, ceiling: 8 },
      pace: { value: { needUsdPerHour: 10, slotUsdPerHour: 1, poolOpen: true }, asOf: ago(1000), ttlMs: 60_000 } };
    expect(decideLane(api, 'green', NOW).target).toBe(8);
    expect(decideLane(api, 'compact2', NOW).target).toBe(3);
    expect(decideLane(api, 'pause', NOW).target).toBe(0);
  });
  it('cloud lanes hold at floor', () => {
    const c: LaneInput = { lane: 'cloud', kind: 'cloud', limits: { target: 4, floor: 1, ceiling: 8 } };
    expect(decideLane(c, 'green', NOW).target).toBe(1);
    expect(cloudCreditReading('vercel').value).toBeNull();
  });
  it('devin step-down: 4 of last 10 non-PR lowers by 2 with floor 6', () => {
    const out = (n: number) => Array.from({ length: 10 }, (_, i) => ({ pr: i >= n }));
    expect(devinStepDown(10, out(4))).toBe(8);
    expect(devinStepDown(7, out(4))).toBe(6);
    expect(devinStepDown(10, out(3))).toBe(10);
    expect(devinStepDown(4, out(9))).toBe(4);
    const d: LaneInput = { lane: 'devin', kind: 'devin', limits: { target: 10, floor: 3, ceiling: 16 }, devinOutcomes: out(5) };
    expect(decideLane(d, 'green', NOW).target).toBe(8);
  });
});

describe('typed readers carry as_of', () => {
  it('anthropic balance needs as_of', () => {
    expect(anthropicBalanceReading({ 'claude-api': { gift: { usd_remaining: '120' } } }).value).toBeNull();
    const r = anthropicBalanceReading({ 'claude-api': { gift: { usd_remaining: '120', as_of: ago(1000) } } });
    expect(r).toMatchObject({ value: { usdRemaining: 120 }, asOf: ago(1000) });
  });
  it('devin allowance needs as_of and a period', () => {
    const ov = { devin: { allowance: { acus: 1000, as_of: ago(1000), period_start: ago(10 * 86400_000), period_end: new Date(NOW + 10 * 86400_000).toISOString() } } };
    expect(devinAllowanceReading(ov, 400, NOW).value).toMatchObject({ allowanceAcus: 1000, usedAcus: 400, periodFraction: 0.5 });
    expect(devinAllowanceReading({ devin: { allowance: { acus: 1000 } } }, 400, NOW).value).toBeNull();
    expect(devinAllowanceReading(ov, null, NOW).value).toBeNull();
  });
  it('codex reading uses the max of rollout windows', () => {
    expect(codexQuotaReading({ primary: { used_percent: 12 }, secondary: { used_percent: 40 } }, ago(1)).value).toEqual({ usedPercent: 40 });
    expect(codexQuotaReading({ primary: { used_percent: 12 } }, null).value).toBeNull();
  });
});

describe('phm resources autopilot', () => {
  it('prints read-only JSON with no input lanes', async () => {
    const { cmdResourceAutopilot } = await import('../src/cli/resource-autopilot.js');
    const logs: string[] = []; const orig = console.log; console.log = (s: string) => { logs.push(s); };
    try { expect(await cmdResourceAutopilot(['--json', '--root', '/'])).toBe(0); } finally { console.log = orig; }
    const out = JSON.parse(logs.join('\n')) as { schema: string; disk: string; lanes: unknown[] };
    expect(out.schema).toBe('phantom.lane-autopilot.v1');
    expect(['green', 'compact1', 'compact2', 'pause']).toContain(out.disk);
  });
  it('rejects unknown flags', async () => {
    const { cmdResourceAutopilot } = await import('../src/cli/resource-autopilot.js');
    expect(await cmdResourceAutopilot(['--write'])).toBe(2);
  });
});

describe('swap growth guard', () => {
  it('high static swap with 80% free allows raising', async () => {
    const { memoryAllowsRaise } = await import('../src/core/resources/lane-autopilot.js');
    expect(memoryAllowsRaise({ freePct: 80, swapUsedGb: 17, swapoutsPerMin: 0 })).toBe(true);
    const i = { ...codex(0), memory: { freePct: 80, swapUsedGb: 17, swapoutsPerMin: 0 } };
    expect(decideLane(i, 'green', NOW).target).toBe(32);
  });
  it('growing swap blocks raising', async () => {
    const { memoryAllowsRaise } = await import('../src/core/resources/lane-autopilot.js');
    expect(memoryAllowsRaise({ freePct: 80, swapUsedGb: 17, swapoutsPerMin: 5000 })).toBe(false);
    const i = { ...codex(0), memory: { freePct: 80, swapUsedGb: 17, swapoutsPerMin: 5000 } };
    expect(decideLane(i, 'green', NOW).target).toBe(10);
  });
  it('low free memory blocks raising even without growth', async () => {
    const { memoryAllowsRaise } = await import('../src/core/resources/lane-autopilot.js');
    expect(memoryAllowsRaise({ freePct: 20, swapUsedGb: 2, swapoutsPerMin: 0 })).toBe(false);
  });
});

describe('Security advisories', () => {
  it('a failed disk read is yellow, not green', () => {
    expect(diskLevel({ freeBytes: NaN, totalBytes: 0, freeInodes: 0, totalInodes: 0 })).toBe('compact1');
    expect(diskLevel({ freeBytes: -1, totalBytes: 128 * GIB, freeInodes: 1, totalInodes: 2 })).toBe('compact1');
  });
  it('17G parked swap at 0/min with high free memory allows raises; above 48G it does not', async () => {
    const { memoryAllowsRaise } = await import('../src/core/resources/lane-autopilot.js');
    expect(memoryAllowsRaise({ freePct: 80, swapUsedGb: 17.1, swapoutsPerMin: 0 })).toBe(true);
    expect(memoryAllowsRaise({ freePct: 80, swapUsedGb: 49, swapoutsPerMin: 0 })).toBe(false);
  });
});

describe('one threshold source (compact block)', () => {
  it('classifies 182G, 250G and 350G the same as compact.sh and autopilot.py (Mac defaults)', async () => {
    const { compactThresholds } = await import('../src/core/resources/lane-autopilot.js');
    const t = compactThresholds({});
    const lvl = (gb: number) => diskLevel({ freeBytes: gb * GIB, totalBytes: 1000 * GIB, freeInodes: 98, totalInodes: 100 }, t);
    expect([lvl(182), lvl(250), lvl(350)]).toEqual(['compact2', 'compact1', 'green']);
  });
  it('reads and caps config values', async () => {
    const { compactThresholds } = await import('../src/core/resources/lane-autopilot.js');
    expect(compactThresholds({ compact: { l1_free_gb: 350, l2_free_gb: 250 } })).toMatchObject({ compact1: 350 * GIB, compact2: 250 * GIB });
    expect(compactThresholds({ compact: { l1_free_gb: 1e9, l2_free_gb: 1e9 } })).toMatchObject({ compact1: 2000 * GIB, compact2: 2000 * GIB });
    expect(compactThresholds({ compact: { l1_free_gb: 100, l2_free_gb: 500 } }).compact2).toBe(100 * GIB);
    expect(compactThresholds({ compact: { l1_free_gb: 'x' } }).compact1).toBe(300 * GIB);
  });
});
