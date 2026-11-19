/**
 * RQ-PHX-QUOTATICKRECOVER633S (slice preserved from PR #5848) — the real
 * cmdFleetSelfTick/runSelfTick path refreshes Claude's native weekly reading
 * before reset-release, with a 30-minute persisted-reading cooldown, whether
 * or not the lane is held. Every probe is a fake; no real claude is spawned.
 * Steps other than reset-release are recording fakes; reset-release is the real verb.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStepName, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { claudeQuotaPath, writeClaudeQuotaReading, type ClaudeQuotaReadingV1 } from '../src/core/fleet/claude-quota-reading.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

const T0 = Date.parse('2026-11-04T12:00:00Z');
const MIN = 60_000;
const ACCOUNT = 'claude:0123456789abcdef';
const OTHER_ACCOUNT = 'claude:fedcba9876543210';

let root: string;
let home: string;
let clock = T0;

const usage = (usedPercent: number, accountScope?: string): ClaudeAccountUsageResult => ({
  schemaVersion: 1, scope: 'claude-native-auth-status', status: 'observed', reason: 'observed', loggedIn: true,
  authMethod: 'claude.ai', subscriptionType: null, accountHint: null, startedAt: '2026-11-04T12:00:00Z',
  finishedAt: '2026-11-04T12:00:01Z', quotaFresh: true,
  windows: [{ id: 'seven_day', usedPercent, resetsAt: '2026-11-08T00:00:00Z' }],
  ...(accountScope ? { accountScope } : {}),
} as unknown as ClaudeAccountUsageResult);
const failedUsage = (): ClaudeAccountUsageResult => ({
  ...usage(0), status: 'unavailable', reason: 'timeout', quotaFresh: false, windows: [],
} as unknown as ClaudeAccountUsageResult);

const reading = (observedAt: string, over: Partial<ClaudeQuotaReadingV1> = {}): ClaudeQuotaReadingV1 => ({
  v: 1, observedAt, reason: 'observed', fresh: true,
  windows: [{ id: 'seven_day', usedPct: 12, resetAt: '2026-11-08T00:00:00Z' }], ...over,
});
const stored = async () => JSON.parse(await readFile(claudeQuotaPath(root), 'utf8')) as ClaudeQuotaReadingV1;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'quota-tick-home-'));
  root = join(home, 'runs');
  clock = T0;
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(join(root, 'queue/slots.json'), JSON.stringify({
    claude: { target: 1, floor: 0, ceiling: 2, held: true, held_reason: 'autobackoff claude job=j-1 until=2026-11-08T00:00:00Z src=fake',
      held_until: '2026-11-08T00:00:00Z', held_by: 'autobackoff', last_change: T0 / 1000 - 3600 },
  }));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: '2026-11-04T11:59:00Z', lanes: {} }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

interface Run { code: number; order: string[]; steps: { step: string; state: string; report: Record<string, unknown> | null }[]; quota: Record<string, unknown> | null; out: string[] }

/** One real self-tick over the temp root; only the reset-release step is the real verb. */
async function tick(args: string[], probe: (() => Promise<ClaudeAccountUsageResult>) | undefined, over: { findCommand?: () => string | null } = {}): Promise<Run> {
  const order: string[] = [];
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.filter(n => n !== 'reset-release').map(name => [name, async () => {
    order.push(name);
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  }])) as Partial<SelfTickSteps>;
  const out: string[] = [];
  const code = await cmdFleetSelfTick(['--json', '--runs-dir', root, ...args], {
    home, now: () => clock, steps, output: t => out.push(t), error: () => undefined,
    ...(probe ? { claudeProbe: probe } : {}),
    claudeFindCommand: over.findCommand ?? (() => '/fake/claude'),
  });
  const report = JSON.parse(out[0]!) as { steps: Run['steps'] };
  const release = report.steps.find(s => s.step === 'reset-release');
  return { code, order, steps: report.steps, quota: (release?.report?.claudeQuota ?? null) as Run['quota'], out };
}

const LATER_STEPS = SELF_TICK_STEP_ORDER.filter((n: SelfTickStepName) => n !== 'reset-release');

it('--apply probes once before reset-release and persists only sanitized weekly evidence', async () => {
  const probe = vi.fn(async () => usage(42, ACCOUNT));
  const r = await tick(['--apply'], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledWith(expect.objectContaining({ command: ['/fake/claude'], timeoutMs: 20_000 }));
  expect(r.quota).toMatchObject({ state: 'probed', weeklyPct: 42 });
  expect(r.steps[0]!.step).toBe('reset-release');
  // reset-release's own held-lane refresh ran after our stage and found the reading already fresh.
  expect(r.steps[0]!.report).toMatchObject({ claudeProbe: 'fresh' });
  expect(await stored()).toEqual({ v: 1, observedAt: new Date(T0).toISOString(), reason: 'observed', fresh: true,
    windows: [{ id: 'seven_day', usedPct: 42, resetAt: '2026-11-08T00:00:00Z' }], accountId: ACCOUNT });
  expect(r.order).toEqual(LATER_STEPS);
  expect(r.code).toBe(0);
});

it('a second tick inside the cooldown makes zero probes; the next one past it probes again', async () => {
  const probe = vi.fn(async () => usage(42, ACCOUNT));
  await tick(['--apply'], probe);
  clock = T0 + 10 * MIN;
  const inside = await tick(['--apply'], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(inside.quota).toMatchObject({ state: 'skipped-fresh', weeklyPct: 42 });
  clock = T0 + 31 * MIN;
  const past = await tick(['--apply'], probe);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(past.quota).toMatchObject({ state: 'probed' });
});

it('dry-run reports the planned stage but spawns no probe and writes no reading', async () => {
  const probe = vi.fn(async () => usage(42, ACCOUNT));
  const findCommand = vi.fn(() => '/fake/claude');
  const r = await tick([], probe, { findCommand });
  expect(probe).not.toHaveBeenCalled();
  expect(r.quota).toMatchObject({ state: 'planned', wouldProbe: true, weeklyPct: null });
  expect(existsSync(claudeQuotaPath(root))).toBe(false);
  expect(r.order).toEqual(LATER_STEPS);
});

it('a fresh cached reading keeps its accountId and is not re-probed', async () => {
  await writeClaudeQuotaReading(root, reading(new Date(T0 - 5 * MIN).toISOString(), { accountId: ACCOUNT }));
  const probe = vi.fn(async () => usage(77, OTHER_ACCOUNT));
  const r = await tick(['--apply'], probe);
  expect(probe).not.toHaveBeenCalled();
  expect(r.quota).toMatchObject({ state: 'skipped-fresh', weeklyPct: 12 });
  expect((await stored()).accountId).toBe(ACCOUNT);
});

it.each([
  ['stale', async () => writeClaudeQuotaReading(root, reading(new Date(T0 - 31 * MIN).toISOString(), { accountId: ACCOUNT }))],
  ['future-dated', async () => writeClaudeQuotaReading(root, reading(new Date(T0 + 3_600_000).toISOString(), { accountId: ACCOUNT }))],
  ['malformed', async () => {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await writeFile(claudeQuotaPath(root), '{"v":1,"observedAt":"2026-11-04T12:00:00Z","fresh":true}');
  }],
  ['unparseable', async () => {
    await mkdir(join(root, 'metrics'), { recursive: true });
    await writeFile(claudeQuotaPath(root), 'not json');
  }],
])('a %s reading does not count as fresh: the stage probes and replaces it', async (_name, seed) => {
  await seed();
  const probe = vi.fn(async () => usage(55, OTHER_ACCOUNT));
  const r = await tick(['--apply'], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(r.quota).toMatchObject({ state: 'probed', weeklyPct: 55 });
  expect(await stored()).toMatchObject({ fresh: true, accountId: OTHER_ACCOUNT, observedAt: new Date(T0).toISOString() });
});

it('a failed probe is stored as unknown, never 0% usage, and later steps still run', async () => {
  const probe = vi.fn(async () => failedUsage());
  const r = await tick(['--apply'], probe);
  expect(r.quota).toMatchObject({ state: 'unavailable', weeklyPct: null });
  expect(await stored()).toMatchObject({ fresh: false, windows: [] });
  expect(r.order).toEqual(LATER_STEPS);
  expect(r.order.at(-1)).toBe('cos-work');
  expect(r.code).toBe(0);
});

it('a throwing probe stays unknown and later steps, cos-work included, still run', async () => {
  const probe = vi.fn(async (): Promise<ClaudeAccountUsageResult> => { throw new Error('boom'); });
  const r = await tick(['--apply'], probe);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(r.quota).toMatchObject({ state: 'unavailable', weeklyPct: null });
  expect(await stored()).toMatchObject({ fresh: false, reason: 'probe-failed', windows: [] });
  expect(r.steps[0]!.state).toBe('ok');
  expect(r.order).toEqual(LATER_STEPS);
  expect(r.code).toBe(0);
});

it('no claude command means no probe and no reading, reported honestly', async () => {
  const probe = vi.fn(async () => usage(42, ACCOUNT));
  const r = await tick(['--apply'], probe, { findCommand: () => null });
  expect(probe).not.toHaveBeenCalled();
  expect(r.quota).toMatchObject({ state: 'unavailable', reason: 'claude-not-found', weeklyPct: null });
  expect(existsSync(claudeQuotaPath(root))).toBe(false);
  expect(r.order).toEqual(LATER_STEPS);
});

it('a custom runs dir with no injected probe never scans PATH or spawns claude', async () => {
  const out: string[] = [];
  const steps = Object.fromEntries(LATER_STEPS.map(name => [name, async () => ({ exitCode: 0, output: '{}' })])) as Partial<SelfTickSteps>;
  await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', root], { home, now: () => clock, steps, output: t => out.push(t), error: () => undefined });
  const release = (JSON.parse(out[0]!) as { steps: { step: string; report: { claudeQuota: unknown } }[] }).steps.find(s => s.step === 'reset-release');
  expect(release?.report.claudeQuota).toMatchObject({ state: 'unavailable', reason: 'custom-runs-dir-no-claude-probe' });
  expect(existsSync(claudeQuotaPath(root))).toBe(false);
});
