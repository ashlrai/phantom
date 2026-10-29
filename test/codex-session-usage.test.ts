/**
 * codex-session-usage.test.ts - RQ-CODEX-USAGE-SOURCE coverage.
 *
 * Redacted synthetic rollout fixtures only: every file written here is
 * fabricated for the test, and the credential file codex keeps next to
 * sessions/ (`auth.json`) is present as a decoy with sentinel content that
 * must never be opened and never appear in any output.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openedPaths = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    openedPaths.paths.push(String(args[0]));
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

import {
  CODEX_FLEET_USAGE_KEY,
  buildCodexResourceReport,
  burnRate,
  codexAccountHomes,
  collectCodexSessionUsages,
  publishCodexFleetUsage,
  readCodexFleetUsage,
  resetCodexUsagePublishThrottle,
  type CodexSessionUsage,
  type CodexUsageSample,
} from '../src/core/fleet/codex-session-usage.js';
import { subscriptionUsage } from '../src/core/fleet/subscription-usage.js';

const AUTH_SENTINEL = 'auth-sentinel-7f3a9c';
const SECRET_SENTINEL = 'sk-' + 'live-d41d8cd98f00b204e9800998ecf8427e';

// Weekly reset lands after every fixture observation time.
const WEEKLY_RESET_S = Math.floor(Date.parse('2036-06-21T00:00:00Z') / 1000);
const SESSION_RESET_S = Math.floor(Date.parse('2036-06-14T17:00:00Z') / 1000);

let tmpHome = '';
const originalEnv = {
  CODEX_HOME: process.env['CODEX_HOME'],
  CODEX_HOME_ALT: process.env['CODEX_HOME_ALT'],
  PHANTOM_FLEET_PATH: process.env['PHANTOM_FLEET_PATH'],
  PHANTOM_FLEET_FILE: process.env['PHANTOM_FLEET_FILE'],
};

function makeHome(): string {
  // realpath so the private-storage path checks see a canonical directory
  // (macOS /var -> /private/var).
  return realpathSync(mkdtempSync(join(tmpdir(), 'codex-usage-test-')));
}

function writeRollout(codexHome: string, name: string, lines: unknown[], date = '2036/06/14'): string {
  const dir = join(codexHome, 'sessions', date);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });
  return file;
}

function tokenCount(ts: string, rateLimits: unknown): unknown {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 12345 } }, rate_limits: rateLimits },
  };
}

function sessionMeta(ts: string): unknown {
  return {
    timestamp: ts,
    type: 'session_meta',
    payload: {
      id: 'thread-redacted',
      timestamp: ts,
      cwd: '/Users/someone/secret-project',
      originator: 'codex_cli_rs',
      cli_version: '0.99.0',
      git: { branch: 'private-branch-name' },
    },
  };
}

function turnContext(ts: string): unknown {
  return { timestamp: ts, type: 'turn_context', payload: { model: 'gpt-5.4-codex', effort: 'high' } };
}

const GOOD_LIMITS = {
  limit_id: 'codex',
  limit_name: 'Codex usage',
  normal_model_slug: 'gpt-5.4-codex',
  primary: { used_percent: 40, window_minutes: 300, resets_at: SESSION_RESET_S },
  secondary: { used_percent: 55, window_minutes: 10_080, resets_at: WEEKLY_RESET_S },
  credits: { has_credits: true, unlimited: false, balance: '42.50' },
  individual_limit: { limit: '100.00', used: '57.50', remaining_percent: 42, resets_at: WEEKLY_RESET_S },
  plan_type: 'pro',
  rate_limit_reached_type: null,
  spend_control_reached: false,
};

function env(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CODEX_HOME: join(home, '.codex'), CODEX_HOME_ALT: join(home, '.codex-2'), ...extra } as NodeJS.ProcessEnv;
}

function makeUsage(overrides: Partial<CodexSessionUsage> = {}): CodexSessionUsage {
  return {
    accountId: 'codex-cmp', slot: 'primary', observedAt: '2036-06-14T12:00:00.000Z',
    planType: 'pro', limitId: 'codex', limitName: 'Codex usage',
    rateLimitReachedType: null, spendControlReached: false,
    individualLimit: { remainingPercent: 42, resetsAt: WEEKLY_RESET_S },
    model: 'gpt-5.4-codex', originator: 'codex_cli_rs', cliVersion: '0.99.0',
    primary: { usedPercent: 40, windowMinutes: 300, resetsAt: SESSION_RESET_S },
    secondary: { usedPercent: 55, windowMinutes: 10_080, resetsAt: WEEKLY_RESET_S },
    credits: { hasCredits: true, unlimited: false, balance: '42.50' },
    ...overrides,
  };
}

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = '';
  vi.restoreAllMocks();
  resetCodexUsagePublishThrottle();
});

describe('codexAccountHomes', () => {
  it('maps the two credential homes to fleet pool ids', () => {
    const homes = codexAccountHomes(env('/h'), '/h');
    expect(homes.map((h) => h.accountId)).toEqual(['codex-cmp', 'codex-personal']);
    expect(homes[0]!.home).toBe(join('/h', '.codex'));
    expect(homes[1]!.home).toBe(join('/h', '.codex-2'));
  });

  it('defaults to ~/.codex and ~/.codex-2 without env', () => {
    const homes = codexAccountHomes({}, '/home/tester');
    expect(homes.map((h) => h.home)).toEqual([join('/home/tester', '.codex'), join('/home/tester', '.codex-2')]);
  });

  it('collapses identical resolved homes to the primary', () => {
    const homes = codexAccountHomes(
      { CODEX_HOME: '/x', CODEX_HOME_ALT: '/x' } as NodeJS.ProcessEnv, '/h');
    expect(homes).toHaveLength(1);
    expect(homes[0]!.accountId).toBe('codex-cmp');
  });
});

describe('collectCodexSessionUsages', () => {
  it('reads rate limits from both account homes', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    mkdirSync(join(tmpHome, '.codex-2'), { recursive: true });
    writeRollout(join(tmpHome, '.codex'), 'rollout-2036-06-14T00-00-00-aaa.jsonl', [
      sessionMeta('2036-06-14T00:00:00Z'),
      turnContext('2036-06-14T00:00:01Z'),
      tokenCount('2036-06-14T00:05:00Z', GOOD_LIMITS),
    ]);
    writeRollout(join(tmpHome, '.codex-2'), 'rollout-2036-06-14T00-00-00-bbb.jsonl', [
      sessionMeta('2036-06-14T00:00:00Z'),
      tokenCount('2036-06-14T00:04:00Z', {
        primary: { used_percent: 12, window_minutes: 300, resets_at: SESSION_RESET_S },
        secondary: { used_percent: 88, window_minutes: 10_080, resets_at: WEEKLY_RESET_S },
        plan_type: 'team',
      }),
    ]);
    const usages = collectCodexSessionUsages({ env: env(tmpHome), homeDir: tmpHome });
    expect(usages).toHaveLength(2);
    const cmp = usages.find((u) => u.accountId === 'codex-cmp')!;
    const personal = usages.find((u) => u.accountId === 'codex-personal')!;
    expect(cmp.primary?.usedPercent).toBe(40);
    expect(cmp.secondary?.usedPercent).toBe(55);
    expect(cmp.secondary?.resetsAt).toBe(WEEKLY_RESET_S);
    expect(cmp.credits).toEqual({ hasCredits: true, unlimited: false, balance: '42.50' });
    expect(cmp.planType).toBe('pro');
    expect(cmp.model).toBe('gpt-5.4-codex');
    expect(cmp.originator).toBe('codex_cli_rs');
    expect(cmp.cliVersion).toBe('0.99.0');
    expect(cmp.individualLimit).toEqual({ remainingPercent: 42, resetsAt: WEEKLY_RESET_S });
    expect(cmp.observedAt).toBe('2036-06-14T00:05:00.000Z');
    expect(personal.secondary?.usedPercent).toBe(88);
    expect(personal.planType).toBe('team');
  });

  it('drops every non-allowlisted field, including credential-shaped values', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    writeRollout(join(tmpHome, '.codex'), 'rollout-2036-06-14T00-00-00-ccc.jsonl', [
      { timestamp: '2036-06-14T00:00:00Z', type: 'session_meta', payload: { originator: SECRET_SENTINEL } },
      tokenCount('2036-06-14T00:05:00Z', {
        ...GOOD_LIMITS,
        limit_name: SECRET_SENTINEL,
        api_key: SECRET_SENTINEL,
        plan_type: 'definitely-not-a-plan',
        balance_token: SECRET_SENTINEL,
        nested: { bearer: SECRET_SENTINEL },
      }),
      { timestamp: '2036-06-14T00:05:01Z', type: 'response_item', payload: { content: SECRET_SENTINEL } },
    ]);
    const usages = collectCodexSessionUsages({ env: env(tmpHome), homeDir: tmpHome });
    expect(usages).toHaveLength(1);
    const usage = usages[0]!;
    expect(usage.planType).toBeNull(); // unknown plan dropped, not passed through
    expect(usage.originator).toBeNull(); // secret-shaped originator dropped
    expect(usage.limitName).toBeNull(); // secret-shaped label dropped
    const serialized = JSON.stringify(usage);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('balance_token');
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('secret-project');
    expect(serialized).not.toContain('private-branch-name');
    expect(serialized).not.toContain('thread-redacted');
  });

  it('treats a home with no rate-limit evidence as unknown, not zero', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    writeRollout(join(tmpHome, '.codex'), 'rollout-2036-06-14T00-00-00-ddd.jsonl', [
      sessionMeta('2036-06-14T00:00:00Z'),
      tokenCount('2036-06-14T00:05:00Z', null), // codex writes null when unavailable
    ]);
    const usages = collectCodexSessionUsages({ env: env(tmpHome), homeDir: tmpHome });
    expect(usages).toHaveLength(1);
    expect(usages[0]!.primary).toBeNull();
    expect(usages[0]!.secondary).toBeNull();
    expect(usages[0]!.credits).toBeNull();
  });

  it('omits homes that do not exist', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    const usages = collectCodexSessionUsages({ env: env(tmpHome), homeDir: tmpHome });
    expect(usages.map((u) => u.accountId)).toEqual(['codex-cmp']);
  });

  it('never opens auth.json or anything outside sessions/rollout-*.jsonl', () => {
    tmpHome = makeHome();
    const codexHome = join(tmpHome, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), `{"OPENAI_API_KEY":"${AUTH_SENTINEL}"}`, { mode: 0o600 });
    writeFileSync(join(codexHome, 'config.toml'), 'model = "x"', { mode: 0o600 });
    writeFileSync(join(codexHome, 'history.jsonl'), AUTH_SENTINEL, { mode: 0o600 });
    writeRollout(codexHome, 'rollout-2036-06-14T00-00-00-eee.jsonl', [
      tokenCount('2036-06-14T00:05:00Z', GOOD_LIMITS),
    ]);
    // Non-rollout files inside the sessions tree must not be opened either.
    const dayDir = join(codexHome, 'sessions', '2036', '06', '14');
    writeFileSync(join(dayDir, 'auth.json'), `{"k":"${AUTH_SENTINEL}"}`, { mode: 0o600 });
    writeFileSync(join(dayDir, 'notes.txt'), AUTH_SENTINEL, { mode: 0o600 });
    writeFileSync(join(dayDir, 'rollout-evil.json'), AUTH_SENTINEL, { mode: 0o600 });

    openedPaths.paths.length = 0;
    const usages = collectCodexSessionUsages({ env: env(tmpHome), homeDir: tmpHome });
    expect(usages).toHaveLength(1);
    const opened = openedPaths.paths.filter((p) => p.startsWith(tmpHome));
    expect(opened.length).toBeGreaterThan(0);
    for (const p of opened) {
      expect(p).toMatch(/rollout-.*\.jsonl$/);
      expect(p).not.toContain('auth.json');
      expect(p).not.toContain('notes.txt');
      expect(p).not.toContain('history.jsonl');
      expect(p).not.toContain('config.toml');
    }
  });
});

describe('buildCodexResourceReport', () => {
  it('emits the resource.v1 shape with used/left/reset per window', () => {
    const report = buildCodexResourceReport([makeUsage()], [], Date.parse('2036-06-14T12:00:30Z'));
    expect(report.v).toBe('resource.v1');
    expect(report.resources).toHaveLength(1);
    const res = report.resources[0]!;
    expect(res.id).toBe('codex-cmp');
    expect(res.provider).toBe('codex');
    expect(res.slot).toBe('primary');
    expect(res.state).toBe('current');
    expect(res.weekly?.kind).toBe('weekly');
    expect(res.weekly?.usedPct).toBe(55);
    expect(res.weekly?.leftPct).toBe(45);
    expect(res.weekly?.resetsAt).toBe(new Date(WEEKLY_RESET_S * 1000).toISOString());
    expect(res.weekly?.windowMinutes).toBe(10_080);
    expect(res.session?.kind).toBe('session');
    expect(res.session?.usedPct).toBe(40);
    expect(res.credits).toEqual({ hasCredits: true, unlimited: false, balance: '42.50' });
    expect(res.individualLimitPercent).toBe(42);
    expect(res.limitId).toBe('codex');
    expect(res.limitName).toBe('Codex usage');
    expect(res.plan).toBe('pro');
    expect(res.model).toBe('gpt-5.4-codex');
    expect(res.cli).toEqual({ originator: 'codex_cli_rs', version: '0.99.0' });
    expect(res.limitReached).toBe(false);
    expect(res.spendControlReached).toBe(false);
  });

  it('marks provider-flagged denials', () => {
    const report = buildCodexResourceReport(
      [makeUsage({ rateLimitReachedType: 'workspace_owner_credits_depleted' })],
      [], Date.parse('2036-06-14T12:00:30Z'));
    expect(report.resources[0]!.limitReached).toBe(true);
    const unknown = buildCodexResourceReport(
      [makeUsage({ rateLimitReachedType: 'made_up_type' as never })],
      [], Date.parse('2036-06-14T12:00:30Z'));
    expect(unknown.resources[0]!.limitReached).toBe(false);
  });

  it('marks stale and unavailable resources', () => {
    const now = Date.parse('2036-06-14T12:00:00Z');
    const stale = buildCodexResourceReport(
      [makeUsage({ observedAt: '2036-06-12T11:00:00Z' })], [], now);
    expect(stale.resources[0]!.state).toBe('stale');
    const empty = buildCodexResourceReport(
      [makeUsage({ observedAt: null, primary: null, secondary: null, credits: null })], [], now);
    expect(empty.resources[0]!.state).toBe('unavailable');
    expect(empty.resources[0]!.weekly).toBeNull();
    expect(empty.resources[0]!.session).toBeNull();
  });

  it('emits no secret-shaped or locator strings', () => {
    const poisoned = makeUsage({
      model: `model-${SECRET_SENTINEL}`,
      limitName: SECRET_SENTINEL,
      observedAt: '2036-06-14T12:00:00Z',
    });
    const report = buildCodexResourceReport([poisoned], [], Date.parse('2036-06-14T12:00:30Z'));
    const res = report.resources[0]!;
    expect(res.model).toBeNull();   // secret-shaped model dropped at emit
    expect(res.limitName).toBeNull();
    const text = JSON.stringify(report);
    expect(text).not.toContain(SECRET_SENTINEL);
    expect(text).not.toContain(AUTH_SENTINEL);
    expect(text).not.toContain('auth.json');
    expect(text).not.toContain(tmpdir());
    expect(text).not.toContain('.codex');
    for (const field of ['id', 'provider', 'slot', 'state'] as const) {
      expect(res[field]).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});

describe('burnRate', () => {
  const at = (h: number) => new Date(h * 3_600_000).toISOString();
  const RESET = '2036-06-21T00:00:00Z';
  const sample = (h: number, pct: number, reset: string | null = RESET): CodexUsageSample => ({
    account: 'codex-cmp', window: 'secondary', at: at(h), usedPct: pct, resetsAt: reset,
  });

  it('measures pct/hour over a non-decreasing run in one reset window', () => {
    const rate = burnRate([sample(0, 10), sample(1, 30), sample(2, 50)], 'codex-cmp', 'secondary');
    expect(rate).toBe(20);
  });

  it('returns null with fewer than two samples', () => {
    expect(burnRate([sample(0, 10)], 'codex-cmp', 'secondary')).toBeNull();
    expect(burnRate([], 'codex-cmp', 'secondary')).toBeNull();
    expect(burnRate([sample(0, 10, null), sample(1, 30, null)], 'codex-cmp', 'secondary')).toBeNull();
  });

  it('stops the measured run at reset boundaries and counter reversals', () => {
    const samples = [
      sample(0, 90, '2036-06-14T00:00:00Z'), // previous reset window
      sample(1, 5),
      sample(2, 15),
      sample(3, 25),
    ];
    expect(burnRate(samples, 'codex-cmp', 'secondary')).toBe(10);
    // A mid-window drop cuts the run: only the post-drop growth counts.
    const reversal = [sample(0, 50), sample(1, 40), sample(2, 60)];
    expect(burnRate(reversal, 'codex-cmp', 'secondary')).toBe(20);
  });

  it('computes projected exhaustion only when it precedes reset', () => {
    const usage = makeUsage({
      observedAt: at(2),
      primary: null,
      secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: 360_000 },
      credits: null,
    });
    const report = buildCodexResourceReport([usage], [sample(0, 20), sample(2, 60)], Date.parse(at(2)));
    const weekly = report.resources[0]!.weekly!;
    expect(weekly.burnPctPerHour).toBe(20);
    expect(weekly.runwayHours).toBeCloseTo(2);
    expect(weekly.projectedExhaustionAt).toBe(at(4));
    // Same burn, but the reset lands first: no projection.
    const nearReset = buildCodexResourceReport(
      [makeUsage({ observedAt: at(2), primary: null, credits: null,
        secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: Date.parse(at(3)) / 1000 } })],
      [sample(0, 20), sample(2, 60)], Date.parse(at(2)));
    expect(nearReset.resources[0]!.weekly!.projectedExhaustionAt).toBeNull();
  });

  it('leaves burn and projection null without history', () => {
    const report = buildCodexResourceReport([makeUsage({ primary: null })], [], Date.parse('2036-06-14T12:00:30Z'));
    const weekly = report.resources[0]!.weekly!;
    expect(weekly.burnPctPerHour).toBeNull();
    expect(weekly.runwayHours).toBeNull();
    expect(weekly.projectedExhaustionAt).toBeNull();
  });
});

describe('publishCodexFleetUsage', () => {
  it('writes the codexUsage extension into fleet.json and keeps sibling fields', () => {
    tmpHome = makeHome();
    const fleetDir = join(tmpHome, 'fleet');
    mkdirSync(fleetDir, { recursive: true, mode: 0o700 });
    const fleetPath = join(fleetDir, 'fleet.json');
    writeFileSync(fleetPath, JSON.stringify({ v: 'fleet.v1', pools: { x: {} } }), { mode: 0o600 });
    const result = publishCodexFleetUsage({
      usages: [makeUsage()], fleetPath, nowMs: Date.parse('2036-06-14T12:00:30Z'), minIntervalMs: 0,
    });
    expect(result.state).toBe('published');
    const doc = JSON.parse(readFileSync(fleetPath, 'utf8'));
    expect(doc['v']).toBe('fleet.v1');
    expect(doc['pools']).toEqual({ x: {} });
    const ext = doc[CODEX_FLEET_USAGE_KEY];
    expect(ext.v).toBe(1);
    expect(ext.report.v).toBe('resource.v1');
    expect(ext.report.resources[0].id).toBe('codex-cmp');
    expect(ext.report.resources[0].weekly.usedPct).toBe(55);
    expect(ext.report.resources[0].weekly.leftPct).toBe(45);
    expect(ext.readings).toHaveLength(2);
    const text = JSON.stringify(doc);
    expect(text).not.toContain(AUTH_SENTINEL);
    expect(text).not.toContain('auth.json');
    const back = readCodexFleetUsage(fleetPath);
    expect(back?.report.resources[0]?.weekly?.resetsAt).toBe(new Date(WEEKLY_RESET_S * 1000).toISOString());
  });

  it('accumulates samples across publishes and derives burn over time', () => {
    tmpHome = makeHome();
    const fleetPath = join(tmpHome, 'fleet', 'fleet.json');
    const first = publishCodexFleetUsage({
      usages: [makeUsage({ observedAt: '2036-06-14T10:00:00.000Z' })],
      fleetPath, nowMs: Date.parse('2036-06-14T10:00:30Z'), minIntervalMs: 0,
    });
    expect(first.state).toBe('published');
    const second = publishCodexFleetUsage({
      usages: [makeUsage({
        observedAt: '2036-06-14T12:00:00.000Z',
        secondary: { usedPercent: 75, windowMinutes: 10_080, resetsAt: WEEKLY_RESET_S },
      })],
      fleetPath, nowMs: Date.parse('2036-06-14T12:00:30Z'), minIntervalMs: 0,
    });
    expect(second.state).toBe('published');
    const weekly = second.report.resources[0]!.weekly!;
    expect(weekly.burnPctPerHour).toBe(10);
    expect(weekly.projectedExhaustionAt).toBe('2036-06-14T14:30:00.000Z');
    const ext = readCodexFleetUsage(fleetPath)!;
    expect(ext.readings.filter((r) => r.window === 'secondary')).toHaveLength(2);
    // A third publish with the same reading is a no-op.
    const third = publishCodexFleetUsage({
      usages: [makeUsage({
        observedAt: '2036-06-14T12:00:00.000Z',
        secondary: { usedPercent: 75, windowMinutes: 10_080, resetsAt: WEEKLY_RESET_S },
      })],
      fleetPath, nowMs: Date.parse('2036-06-14T12:00:30Z'), minIntervalMs: 0,
    });
    expect(third.state).toBe('unchanged');
  });

  it('refuses to overwrite a corrupt extension', () => {
    tmpHome = makeHome();
    const fleetDir = join(tmpHome, 'fleet');
    mkdirSync(fleetDir, { recursive: true, mode: 0o700 });
    const fleetPath = join(fleetDir, 'fleet.json');
    writeFileSync(fleetPath, JSON.stringify({ [CODEX_FLEET_USAGE_KEY]: { v: 99, readings: 'nope' } }), { mode: 0o600 });
    const result = publishCodexFleetUsage({ usages: [makeUsage()], fleetPath, minIntervalMs: 0 });
    expect(result.state).toBe('refused');
    expect(JSON.parse(readFileSync(fleetPath, 'utf8'))[CODEX_FLEET_USAGE_KEY].v).toBe(99);
  });

  it('skips the write when no account has a reading', () => {
    tmpHome = makeHome();
    const fleetPath = join(tmpHome, 'fleet', 'fleet.json');
    const result = publishCodexFleetUsage({
      usages: [makeUsage({ primary: null, secondary: null, credits: null })],
      fleetPath, minIntervalMs: 0,
    });
    expect(result.state).toBe('empty');
    expect(readCodexFleetUsage(fleetPath)).toBeNull();
  });

  it('rejects paths that are not an absolute fleet.json', () => {
    tmpHome = makeHome();
    const result = publishCodexFleetUsage({
      usages: [makeUsage()], fleetPath: join(tmpHome, 'not-fleet.json'), minIntervalMs: 0,
    });
    expect(result.state).toBe('unavailable');
  });
});

describe('subscriptionUsage codex integration', () => {
  it('takes the most-saturated window across both accounts', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    mkdirSync(join(tmpHome, '.codex-2'), { recursive: true });
    writeRollout(join(tmpHome, '.codex'), 'rollout-2036-06-14T00-00-00-fff.jsonl', [
      tokenCount('2036-06-14T00:05:00Z', {
        primary: { used_percent: 10, window_minutes: 300, resets_at: SESSION_RESET_S },
        secondary: { used_percent: 20, window_minutes: 10_080, resets_at: WEEKLY_RESET_S },
        plan_type: 'pro',
      }),
    ]);
    writeRollout(join(tmpHome, '.codex-2'), 'rollout-2036-06-14T00-00-00-ggg.jsonl', [
      tokenCount('2036-06-14T00:04:00Z', {
        primary: { used_percent: 15, window_minutes: 300, resets_at: SESSION_RESET_S },
        secondary: { used_percent: 77, window_minutes: 10_080, resets_at: WEEKLY_RESET_S },
        plan_type: 'team',
      }),
    ]);
    process.env['CODEX_HOME'] = join(tmpHome, '.codex');
    process.env['CODEX_HOME_ALT'] = join(tmpHome, '.codex-2');
    process.env['PHANTOM_FLEET_PATH'] = join(tmpHome, 'fleet', 'fleet.json');
    const usage = subscriptionUsage('codex');
    expect(usage).not.toBeNull();
    expect(usage!.usedPercent).toBe(77);
    expect(usage!.windowLabel).toBe('1w');
    expect(usage!.resetsAt).toBe(WEEKLY_RESET_S);
    // The fleet.json extension landed as a side effect.
    const ext = readCodexFleetUsage(join(tmpHome, 'fleet', 'fleet.json'));
    expect(ext?.report.v).toBe('resource.v1');
    expect(ext?.report.resources.map((r) => r.id).sort()).toEqual(['codex-cmp', 'codex-personal']);
    expect(ext?.report.resources.find((r) => r.id === 'codex-personal')?.weekly?.usedPct).toBe(77);
  });

  it('returns null when no codex account has a reading', () => {
    tmpHome = makeHome();
    mkdirSync(join(tmpHome, '.codex'), { recursive: true });
    mkdirSync(join(tmpHome, '.codex-2'), { recursive: true });
    process.env['CODEX_HOME'] = join(tmpHome, '.codex');
    process.env['CODEX_HOME_ALT'] = join(tmpHome, '.codex-2');
    process.env['PHANTOM_FLEET_PATH'] = join(tmpHome, 'fleet', 'fleet.json');
    const usage = subscriptionUsage('codex');
    expect(usage).toBeNull();
  });
});
