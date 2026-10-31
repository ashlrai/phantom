import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { collectTopSnapshot, topFleetPath } from '../src/core/fleet/top.js';
import { cmdTop } from '../src/cli/top.js';

const now = Date.parse('2026-10-26T16:00:00.000Z');
const observedAt = new Date(now).toISOString();
const resetAt = new Date(now + 2 * 3_600_000).toISOString();
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/top-fleet.json'), 'utf8'));
const schema = JSON.parse(readFileSync(join(import.meta.dirname, '../schema/top.v1.schema.json'), 'utf8'));
const validate = new AjvJsonSchemaValidator().getValidator(schema);
let home: string;

function write(relative: string, data: unknown): void {
  const file = join(home, relative);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

function seat(engine = 'codex', seatId = 'codex-cmp', usedPercent = 20) {
  return { seatId, engine, label: 'fixture-private-value', free: false, signedOut: false,
    reachable: true, contextWindow: null, spentTodayUsd: null, observedAt,
    accountHint: 'a'.repeat(64), windows: [{ id: engine === 'codex' ? 'codex_codex_secondary' : 'seven_day',
      usedPercent, resetsAt: resetAt, resetDescription: 'fixture-private-value', limitReached: false,
      resetProvenance: { kind: 'weekly-deadline', at: resetAt, description: 'fixture-private-value',
        source: engine === 'codex' ? 'codex-native-rate-limits' : 'claude-native-usage-report',
        plan: 'pro', ...(engine === 'codex' ? { windowDurationMins: 10080 } : {}) } }] };
}

function capacity(seats = [seat(), seat('claude', 'claude-main', 40)]) {
  write('.ashlr/routing/capacity.json', { v: 1, publishedAt: observedAt, seats });
}

function setupFixture(): void {
  write('.ashlr/fleet/fleet.json', fixture);
  capacity();
  write('.ashlr/config.json', { foundry: { limits: { codex: { max: 10, window: '1h' } } },
    fleet: { sharedQueue: { mode: 'filesystem', path: join(home, 'must-not-write') } } });
  write('.ashlr/budget.json', { mode: 'balanced', updatedAt: observedAt,
    seats: { 'codex-cmp': { seatId: 'codex-cmp', enabled: true, reservePercent: 20 } } });
  write('.ashlr/fleet/quota.json', { events: [
    { backend: 'codex', ts: observedAt, reservationIdHash: 'fixture-private-value' },
    { backend: 'codex', ts: new Date(now - 3_600_000).toISOString() },
    { backend: 'codex', ts: new Date(now - 3_600_001).toISOString() },
    { backend: 'codex', ts: new Date(now + 1).toISOString() },
    { backend: 'claude', ts: observedAt },
  ] });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phantom-top-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const snapshot = () => collectTopSnapshot({ nowMs: now });

describe('top.v1 fleet fixture snapshot', () => {
  it('maps agents/jobs and uses account usage, reserve-aware reset pace and engine quota', () => {
    setupFixture();
    const result = snapshot();
    expect(result.schemaVersion).toBe('top.v1');
    expect(result.observedAt).toBe(observedAt);
    expect(result.sources).toEqual({ fleet: 'ready', capacity: 'ready', quota: 'ready', config: 'ready', budget: 'ready' });
    expect(Object.keys(result.pools)).toEqual(['claude-main', 'codex-cmp']);
    expect(result.pools['codex-cmp']).toEqual({
      engine: 'codex', seatId: 'codex-cmp',
      usage: { source: 'capacity', freshness: 'current', scope: 'seat', observedAt, usedPercent: 20 },
      quota: { scope: 'engine', used: 2, limit: 10, window: '1h' },
      reset: { kind: 'weekly-deadline', at: resetAt }, admission: 'eligible', headroomPercent: 60,
      paceToReset: { secondsRemaining: 7200, headroomPercentPerHour: 30 },
    });
    expect(result.agents).toEqual({
      'agent-a': { poolId: 'claude-main', jobId: null, state: 'idle' },
      'agent-b': { poolId: 'codex-cmp', jobId: 'RQ-PLAN-TOP-A', state: 'running' },
    });
    expect(result.jobs).toEqual({
      'RQ-NEXT': { poolId: 'claude-main', agentId: null, state: 'queued' },
      'RQ-PLAN-TOP-A': { poolId: 'codex-cmp', agentId: 'agent-b', state: 'running' },
    });
    expect(result.pools['claude-main']?.usage.usedPercent).toBe(40);
    expect(result.pools['claude-main']?.paceToReset?.headroomPercentPerHour).toBe(10);
    expect(JSON.stringify(result)).not.toContain('fixture-private-value');
    expect(JSON.stringify(result)).not.toContain('accountHint');
    expect(validate(result).valid).toBe(true);
  });

  it('performs no writes, including shared ledger publication', () => {
    setupFixture();
    const files = () => readdirSync(home, { recursive: true }).sort();
    const before = files();
    const contents = before.filter((file) => String(file).endsWith('.json'))
      .map((file) => [file, readFileSync(join(home, String(file)), 'utf8')]);
    snapshot();
    expect(files()).toEqual(before);
    for (const [file, content] of contents) expect(readFileSync(join(home, String(file)), 'utf8')).toBe(content);
  });

  it.each([-16 * 60_000, 1])('does not calculate pace from stale/future evidence (%i ms)', (delta) => {
    setupFixture();
    const stale = seat();
    stale.observedAt = new Date(now + delta).toISOString();
    capacity([stale]);
    expect(snapshot().pools['codex-cmp']).toMatchObject({ admission: 'unknown', headroomPercent: null,
      paceToReset: null, usage: { usedPercent: null } });
  });

  it.each(['unknown', 'rolling-release', 'expired', 'held'])('does not calculate pace for %s reset/admission', (kind) => {
    setupFixture();
    const value = seat();
    if (kind === 'held') value.signedOut = true;
    else if (kind === 'expired') {
      value.windows[0]!.resetsAt = observedAt;
      value.windows[0]!.resetProvenance.at = observedAt;
    } else Object.assign(value.windows[0]!.resetProvenance, { kind });
    capacity([value]);
    expect(snapshot().pools['codex-cmp']?.paceToReset).toBeNull();
  });

  it('uses a qualified fixed period and preserves zero usage as known', () => {
    setupFixture();
    const value = seat('codex', 'codex-cmp', 0);
    Object.assign(value.windows[0]!.resetProvenance, { kind: 'fixed-period',
      startsAt: new Date(now - 3_600_000).toISOString(), source: 'provider-period' });
    capacity([value]);
    expect(snapshot().pools['codex-cmp']).toMatchObject({ usage: { usedPercent: 0, freshness: 'current' },
      reset: { kind: 'fixed-period', at: resetAt }, paceToReset: { secondsRemaining: 7200, headroomPercentPerHour: 40 } });
  });

  it.each(['duplicate', 'wrong-engine'])('withholds metrics for an ambiguous seat binding: %s', (kind) => {
    setupFixture();
    capacity(kind === 'duplicate' ? [seat(), seat()] : [seat('claude', 'codex-cmp')]);
    expect(snapshot().pools['codex-cmp']).toMatchObject({ usage: { usedPercent: null }, paceToReset: null });
  });

  it('ignores model-specific exhaustion but refuses partially unknown account windows', () => {
    setupFixture();
    const value = seat('claude', 'claude-main', 40);
    value.windows.push({ ...value.windows[0]!, id: 'seven_day_fable', usedPercent: 100 });
    capacity([value]);
    expect(snapshot().pools['claude-main']?.usage.usedPercent).toBe(40);
    write('.ashlr/routing/capacity.json', { v: 1, publishedAt: observedAt, seats: [{ ...value,
      windows: [...value.windows, { ...value.windows[0], id: 'five_hour', usedPercent: null }] }] });
    expect(snapshot().pools['claude-main']).toMatchObject({ usage: { usedPercent: null }, paceToReset: null });
  });

  it('keeps malformed or missing quota unknown and excludes future dispatch events', () => {
    setupFixture();
    for (const value of [null, {}, { events: [{ backend: 'codex', ts: 'invalid' }] }]) {
      write('.ashlr/fleet/quota.json', value);
      expect(snapshot().sources.quota).toBe('unavailable');
      expect(snapshot().pools['codex-cmp']?.quota.used).toBeNull();
    }
    rmSync(join(home, '.ashlr/fleet/quota.json'));
    expect(snapshot().pools['codex-cmp']?.quota.used).toBeNull();
  });

  it('does not treat unreadable config as an unlimited quota', () => {
    setupFixture();
    writeFileSync(join(home, '.ashlr/config.json'), '{');
    expect(snapshot().sources.config).toBe('unavailable');
    expect(snapshot().pools['codex-cmp']?.quota).toEqual({ scope: 'engine', used: null, limit: null, window: null });
  });

  it('withholds policy-derived metrics when the saved budget cannot be read', () => {
    setupFixture();
    writeFileSync(join(home, '.ashlr/budget.json'), '{');
    expect(snapshot().sources.budget).toBe('unavailable');
    expect(snapshot().pools['codex-cmp']).toMatchObject({ admission: 'unknown', headroomPercent: null, paceToReset: null });
  });

  it('canonicalizes accepted source dates to schema date-times', () => {
    setupFixture();
    const value = seat();
    value.observedAt = '2026-10-26T16:00:00Z';
    Object.assign(value.windows[0], { resetsAt: '2026-10-26T18:00:00Z', resetProvenance: undefined });
    capacity([value]);
    expect(snapshot().pools['codex-cmp']?.usage.observedAt).toBe(observedAt);
    expect(snapshot().pools['codex-cmp']?.reset.at).toBe(resetAt);
    expect(validate(snapshot()).valid).toBe(true);
  });

  it('labels local subscription telemetry unverified and never derives pace or shares it between accounts', () => {
    setupFixture();
    const transcript = join(home, '.codex/sessions/2026/10/26/fixture.jsonl');
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: 'event_msg', timestamp: '2026-10-20T00:00:00Z',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 35,
        window_minutes: 300, resets_at: Date.parse(resetAt) / 1000 } } } }) + '\n');
    const pools: Record<string, { engine: string; seatId?: string }> = { a: { engine: 'codex' } };
    write('.ashlr/fleet/fleet.json', { pools, agents: {}, jobs: {} });
    expect(snapshot().pools.a).toMatchObject({
      usage: { source: 'subscription', freshness: 'unverified', scope: 'engine', observedAt: null, usedPercent: 35 },
      admission: 'unknown', headroomPercent: null, paceToReset: null,
    });
    expect(readdirSync(home)).not.toContain('must-not-write');
    pools.b = { engine: 'codex' };
    write('.ashlr/fleet/fleet.json', { pools, agents: {}, jobs: {} });
    expect(snapshot().pools.a?.usage.usedPercent).toBeNull();
    expect(snapshot().pools.b?.usage.usedPercent).toBeNull();
    delete pools.b;
    pools.a!.seatId = 'missing-seat';
    write('.ashlr/fleet/fleet.json', { pools, agents: {}, jobs: {} });
    expect(snapshot().pools.a?.usage.usedPercent).toBeNull();
  });

  it('returns an unavailable empty map for missing/corrupt/oversized/symlink fleet input', () => {
    expect(snapshot().sources.fleet).toBe('unavailable');
    expect(readdirSync(home)).toEqual([]);
    setupFixture();
    for (const text of ['{', ' '.repeat(1024 * 1024 + 1)]) {
      writeFileSync(topFleetPath(), text);
      expect(snapshot()).toMatchObject({ sources: { fleet: 'unavailable' }, pools: {}, agents: {}, jobs: {} });
    }
    rmSync(topFleetPath());
    write('elsewhere.json', fixture);
    symlinkSync(join(home, 'elsewhere.json'), topFleetPath());
    expect(snapshot().sources.fleet).toBe('unavailable');
  });

  it.each(['missing-pool', 'missing-job', 'cross-pool', 'conflicting-link', 'unsafe-id'])('rejects %s fleet references', (kind) => {
    setupFixture();
    const bad = structuredClone(fixture);
    if (kind === 'missing-pool') bad.agents['agent-b'].poolId = 'missing';
    if (kind === 'missing-job') bad.agents['agent-b'].jobId = 'missing';
    if (kind === 'cross-pool') bad.jobs['RQ-PLAN-TOP-A'].poolId = 'claude-main';
    if (kind === 'conflicting-link') bad.jobs['RQ-PLAN-TOP-A'].agentId = 'agent-a';
    if (kind === 'unsafe-id') bad.agents.constructor = { poolId: 'codex-cmp', state: 'idle' };
    write('.ashlr/fleet/fleet.json', bad);
    expect(snapshot().sources.fleet).toBe('unavailable');
  });

  it('keeps same-engine pools distinct and never attributes unbound local usage to a seat', () => {
    setupFixture();
    const second = seat('codex', 'codex-other', 65);
    capacity([seat(), second]);
    write('.ashlr/fleet/fleet.json', { pools: { a: { engine: 'codex', seatId: 'codex-cmp' },
      b: { engine: 'codex', seatId: 'codex-other' }, c: { engine: 'codex' } }, agents: {}, jobs: {} });
    expect(snapshot().pools.a?.usage.usedPercent).toBe(20);
    expect(snapshot().pools.b?.usage.usedPercent).toBe(65);
    expect(snapshot().pools.c?.usage.usedPercent).toBeNull();
  });
});

describe('top.v1 schema', () => {
  it('validates an unavailable snapshot and an empty valid fleet', () => {
    expect(validate(snapshot()).valid).toBe(true);
    write('.ashlr/fleet/fleet.json', { pools: {}, agents: {}, jobs: {} });
    expect(snapshot().sources.fleet).toBe('ready');
    expect(validate(snapshot()).valid).toBe(true);
  });
  it('rejects unknown fields at every output object boundary', () => {
    setupFixture();
    const value = snapshot();
    const targets = [value, value.sources, value.pools['codex-cmp']!, value.pools['codex-cmp']!.usage,
      value.pools['codex-cmp']!.quota, value.pools['codex-cmp']!.reset, value.pools['codex-cmp']!.paceToReset!,
      value.agents['agent-b']!, value.jobs['RQ-PLAN-TOP-A']!];
    for (const target of targets) {
      Object.assign(target, { credential: 'fixture-private-value' });
      expect(validate(value).valid).toBe(false);
      delete (target as unknown as Record<string, unknown>).credential;
    }
  });
  it('rejects wrong versions, missing metrics and out-of-range usage', () => {
    setupFixture();
    expect(validate({ ...snapshot(), schemaVersion: 'top.v2' }).valid).toBe(false);
    const value = snapshot();
    value.pools['codex-cmp']!.usage.usedPercent = 101;
    expect(validate(value).valid).toBe(false);
    value.pools['codex-cmp']!.usage.usedPercent = 20;
    delete (value.pools['codex-cmp'] as unknown as Record<string, unknown>).usage;
    expect(validate(value).valid).toBe(false);
  });
});

describe('phm top --json', () => {
  it('prints exactly one JSON object with no rendering', async () => {
    setupFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTop(['--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(validate(JSON.parse(String(log.mock.calls[0]![0]))).valid).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
  it('supports an explicit fleet path and emits unavailable JSON with exit 1', async () => {
    write('custom.json', { pools: {}, agents: {}, jobs: {} });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTop(['--fleet', join(home, 'custom.json'), '--json'])).toBe(0);
    expect(await cmdTop(['--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[1]![0])).sources.fleet).toBe('unavailable');
  });
  it.each([[], ['--watch'], ['--json', '--fleet'], ['--json', '--json'], ['--json', 'oops']])('rejects unsupported arguments: %j', async (...args) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdTop(args as string[])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
  it('prints help without reading or creating state', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdTop(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith('Usage: phm top --json [--fleet <path>]');
    expect(readdirSync(home)).toEqual([]);
  });
});
