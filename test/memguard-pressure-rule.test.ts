import { describe, expect, it, vi } from 'vitest';
import { MemguardRules, DEFAULT_CONFIG, type Sample } from '../contrib/mac/memguard/rules.js';
import { createMacMemguard, parsePressureLevel, parseSwapUsedBytes } from '../contrib/mac/memguard/mac.js';

const healthy: Sample = {
  nowMs: 600_000, freePercent: 50, diskPause: false, pressureLevel: 1, swapUsedBytes: 8_000_000_000,
};
const point = (nowMs: number, swapUsedBytes: number): Sample => ({ ...healthy, nowMs, swapUsedBytes });

const fixtures = [
  { name: 'pressure level 2', patch: { pressureLevel: 2 }, reasons: ['pressure'] },
  { name: 'pressure above 2', patch: { pressureLevel: 4 }, reasons: ['pressure'] },
  { name: 'hard free memory', patch: { freePercent: 24.99 }, reasons: ['free-hard'] },
  { name: 'unchanged disk rule', patch: { diskPause: true }, reasons: ['disk'] },
  { name: 'exact hard boundary', patch: { freePercent: 25 }, reasons: [] },
  { name: 'interim free memory replaced', patch: { freePercent: 30 }, reasons: [] },
  { name: 'all independent triggers', patch: { freePercent: 24, diskPause: true, pressureLevel: 2 },
    reasons: ['free-hard', 'disk', 'pressure'] },
];

describe('Mac memguard pressure policy', () => {
  it.each(fixtures)('$name with flag ON', ({ patch, reasons }) => {
    const decision = new MemguardRules({ pressureRuleEnabled: true }).evaluate({ ...healthy, ...patch });
    expect(decision.reasons).toEqual(reasons);
    expect(decision.pause).toBe(reasons.length > 0);
  });

  it('defaults OFF, including omitted config and an empty config', () => {
    expect(DEFAULT_CONFIG.pressureRuleEnabled).toBe(false);
    for (const rules of [new MemguardRules(), new MemguardRules({}), new MemguardRules({ pressureRuleEnabled: false })]) {
      expect(rules.pressureRuleEnabled).toBe(false);
      expect(rules.evaluate({ ...healthy, freePercent: 34.99 }).reasons).toEqual(['free-interim']);
      expect(rules.evaluate({ ...healthy, freePercent: 35, pressureLevel: 4 }).pause).toBe(false);
      expect(rules.evaluate({ ...healthy, freePercent: 24, diskPause: true }).reasons)
        .toEqual(['free-hard', 'disk', 'free-interim']);
      expect(rules.evaluate({ ...healthy, diskPause: true }).reasons).toEqual(['disk']);
      expect(rules.evaluate({ ...healthy, swapUsedBytes: 100_000_000_000 }).pause).toBe(false);
    }
  });

  it.each([undefined, null, 'true', 'false', 1])('does not coerce a config flag: %s', value => {
    if (value === undefined) {
      expect(new MemguardRules({ pressureRuleEnabled: value }).pressureRuleEnabled).toBe(false);
    } else {
      expect(() => new MemguardRules({ pressureRuleEnabled: value as unknown as boolean })).toThrow(TypeError);
    }
  });

  it.each([
    { name: 'over 2 GB at ten minutes', elapsed: 600_000, bytes: 3_000_000_001, pause: true },
    { name: 'over 2 GB before ten minutes', elapsed: 60_000, bytes: 3_000_000_001, pause: true },
    { name: 'exactly 2 GB', elapsed: 600_000, bytes: 3_000_000_000, pause: false },
    { name: 'below 2 GB', elapsed: 600_000, bytes: 2_999_999_999, pause: false },
    { name: 'expired baseline', elapsed: 600_001, bytes: 3_000_000_001, pause: false },
  ])('$name', ({ elapsed, bytes, pause }) => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    expect(rules.evaluate(point(0, 1_000_000_000)).pause).toBe(false);
    const decision = rules.evaluate(point(elapsed, bytes));
    expect(decision.pause).toBe(pause);
    expect(decision.reasons).toEqual(pause ? ['swap-growth'] : []);
  });

  it('never pauses for stale high swap without growth, including startup', () => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    for (const time of [0, 60_000, 600_000, 660_000, 1_800_000]) {
      expect(rules.evaluate({ ...point(time, 24_000_000_000), freePercent: 30 }))
        .toEqual({ pause: false, reasons: [], swapGrowthBytes: 0 });
    }
  });

  it('uses the rolling low point, and expires it after ten minutes', () => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    rules.evaluate(point(0, 8_000_000_000));
    rules.evaluate(point(60_000, 1_000_000_000));
    rules.evaluate(point(120_000, 2_000_000_000));
    expect(rules.evaluate(point(660_000, 3_000_000_001)).reasons).toEqual(['swap-growth']);
    expect(rules.evaluate(point(660_001, 3_000_000_001)).pause).toBe(false);
  });

  it('matches a full-window reference over fluctuating swap readings', () => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    const history: { nowMs: number; bytes: number }[] = [];
    let seed = 17;
    for (let tick = 0; tick < 300; tick++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const nowMs = tick * 17_000;
      const bytes = seed * 3;
      const expected = history.filter(p => nowMs - p.nowMs <= 600_000)
        .reduce((growth, p) => Math.max(growth, bytes - p.bytes), 0);
      const decision = rules.evaluate(point(nowMs, bytes));
      expect(decision.swapGrowthBytes).toBe(expected);
      expect(decision.pause).toBe(expected > 2_000_000_000);
      history.push({ nowMs, bytes });
    }
  });

  it('resets history on clock rollback and does not infer growth from old state', () => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    rules.evaluate(point(100_000, 0));
    expect(rules.evaluate(point(10, 5_000_000_000)).pause).toBe(false);
    expect(rules.evaluate(point(20, 7_000_000_001)).reasons).toEqual(['swap-growth']);
  });

  it.each([
    { pressureLevel: null }, { pressureLevel: NaN }, { pressureLevel: -1 }, { pressureLevel: 1.5 },
    { swapUsedBytes: null }, { swapUsedBytes: -1 }, { swapUsedBytes: Infinity },
    { swapUsedBytes: 1.5 }, { nowMs: NaN }, { freePercent: NaN }, { freePercent: 101 },
    { diskPause: undefined },
  ])('holds on invalid telemetry: %j', patch => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    expect(rules.evaluate({ ...healthy, ...patch } as Sample).reasons).toContain('telemetry-unavailable');
  });

  it('retains hard guards on telemetry failure and clears broken swap history', () => {
    const rules = new MemguardRules({ pressureRuleEnabled: true });
    rules.evaluate(point(0, 0));
    expect(rules.evaluate({ ...healthy, freePercent: 20, diskPause: true, swapUsedBytes: null }).reasons)
      .toEqual(['free-hard', 'disk', 'telemetry-unavailable']);
    expect(rules.evaluate(point(600_001, 10_000_000_000)).pause).toBe(false);
  });
});

describe('Mac telemetry adapter', () => {
  it.each([
    ['total = 8192.00M  used = 2048.50M  free = 6143.50M (encrypted)', 2_148_007_936],
    ['used = 2G', 2_147_483_648], ['used = 1K', 1024], ['used = 1T', 1_099_511_627_776],
    ['used = 0.00M', 0], ['used = -1M', null], ['unavailable', null], ['used = 2Z', null],
    ['used = 999999999999999T', null],
  ])('parses swap usage %s', (output, expected) => expect(parseSwapUsedBytes(output)).toBe(expected));

  it.each([['1\n', 1], ['2', 2], ['4', 4], ['2garbage', null], ['', null], ['-1', null], ['1.5', null]])(
    'parses raw pressure %s', (output, expected) => expect(parsePressureLevel(output as string)).toBe(expected),
  );

  it('does no new sysctl reads with the default OFF config', () => {
    const readSysctl = vi.fn(() => { throw new Error('must not probe'); });
    const tick = createMacMemguard({}, { platform: 'darwin', readSysctl, now: () => 0 });
    expect(tick(30, false).reasons).toEqual(['free-interim']);
    expect(tick(50, true).reasons).toEqual(['disk']);
    expect(readSysctl).not.toHaveBeenCalled();
  });

  it('feeds successive Mac readings into the rolling policy', () => {
    let time = 0;
    let used = '0.00M';
    const readSysctl = vi.fn((key: string) => key === 'vm.swapusage' ? `used = ${used}` : '1\n');
    const tick = createMacMemguard({ pressureRuleEnabled: true }, {
      platform: 'darwin', readSysctl, now: () => time,
    });
    expect(tick(30, false).pause).toBe(false);
    used = '2048.00M';
    time = 600_000;
    expect(tick(30, false).reasons).toEqual(['swap-growth']);
    time = 600_001;
    expect(tick(30, false).pause).toBe(false);
    expect(readSysctl.mock.calls.map(([key]) => key)).toEqual([
      'kern.memorystatus_vm_pressure_level', 'vm.swapusage',
      'kern.memorystatus_vm_pressure_level', 'vm.swapusage',
      'kern.memorystatus_vm_pressure_level', 'vm.swapusage',
    ]);
  });

  it('preserves pressure and disk triggers when swap sysctl fails', () => {
    const tick = createMacMemguard({ pressureRuleEnabled: true }, {
      platform: 'darwin', now: () => 0,
      readSysctl: key => { if (key === 'vm.swapusage') throw new Error('sysctl unavailable'); return '2'; },
    });
    expect(tick(50, true).reasons).toEqual(['disk', 'pressure', 'telemetry-unavailable']);
  });

  it('refuses to run the Mac collector on another platform', () => {
    expect(() => createMacMemguard({}, { platform: 'linux', now: () => 0, readSysctl: () => '' }))
      .toThrow('Mac-only');
  });
});
