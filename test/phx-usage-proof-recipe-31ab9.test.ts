import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Record every path the collection layer touches so the test can prove the
// CMP home (~/.codex) and credential files are never opened. The ledger's
// status reads go through node:fs/promises and stay real.
const calls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => { calls.paths.push(String(args[0])); return fn(...args); };
  return { ...actual,
    lstatSync: record(actual.lstatSync) as typeof actual.lstatSync,
    readdirSync: record(actual.readdirSync) as typeof actual.readdirSync,
    openSync: record(actual.openSync) as typeof actual.openSync };
});

import { cmdResources } from '../src/cli/resources.js';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import type { CodexAccountResource, CodexResourceReport } from '../src/core/fleet/codex-session-usage.js';

type FreshnessCheck = { v: number; maxAgeSeconds: number; observedAgeSeconds: number | null; result: string };
type LedgerView = ResourceLedgerV1 & { freshnessCheck?: FreshnessCheck };

const NOW = '2036-10-31T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const TICK = '2036-10-31T11:00:00.000Z';
const OBS_1 = '2036-10-31T11:30:00.000Z';
const OBS_2 = '2036-10-31T11:55:00.000Z';
const WEEKLY_RESET = '2036-11-07T11:30:00.000Z';
const SESSION_RESET = '2036-10-31T16:00:00.000Z';

let root: string;
let personalHome: string;
let cmpHome: string;
let runsDir: string;
let output: ReturnType<typeof vi.spyOn>;
let previousHome: string | undefined;

/** One fake rollout file carrying the last codex rate-limit snapshot. */
function rollout(home: string, name: string, opts: { at: string; sessionPct: number | null; weeklyPct: number | null }): void {
  const day = join(home, 'sessions', opts.at.slice(0, 4), opts.at.slice(5, 7), opts.at.slice(8, 10));
  mkdirSync(day, { recursive: true });
  const window = (used: number, minutes: number, reset: string) => ({
    used_percent: used, window_minutes: minutes, resets_at: Date.parse(reset) / 1000,
  });
  const line = { timestamp: opts.at, type: 'event_msg', payload: { type: 'token_count',
    api_key: 'fake-credential-value', cwd: join(root, 'fake-private-project'),
    rate_limits: { limit_name: 'fake-private-label', plan_type: 'pro',
      primary: opts.sessionPct === null ? null : window(opts.sessionPct, 300, SESSION_RESET),
      secondary: opts.weeklyPct === null ? null : window(opts.weeklyPct, 10080, WEEKLY_RESET) } } };
  const path = join(day, name);
  writeFileSync(path, JSON.stringify(line) + '\n');
  const at = new Date(Date.parse(opts.at));
  utimesSync(path, at, at);
}

/** A dispatch status tick: lane running/target plus the status weekly figure. */
function status(tick: string | null, personalWeekly: number | null): void {
  const dir = join(runsDir, 'queue');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ last_tick: tick,
    lanes: { 'codex-personal': { running: 1, target: 1 },
      'codex-cmp': { running: 2, target: 2 }, claude: { running: 0, target: 2 } },
    budget: { 'codex-personal': { weekly_used_pct: personalWeekly, source: 'status' },
      claude: { weekly_used_pct: 30, source: 'status' } } }));
}

async function personal(): Promise<{ code: number; resource: CodexAccountResource }> {
  const code = await cmdResources(['personal', '--json']);
  const report = JSON.parse(String(output.mock.calls.at(-1)![0])) as CodexResourceReport;
  return { code, resource: report.resources[0]! };
}

const readLedger = () => readResourceLedger({ runsDir, personalCodexHome: personalHome, now: () => nowMs });

async function ledger(args: string[]): Promise<{ code: number; view: LedgerView }> {
  const code = await cmdResourceLedger(args, readLedger, undefined, () => nowMs);
  return { code, view: JSON.parse(String(output.mock.calls.at(-1)![0])) as LedgerView };
}

const laneOf = (view: LedgerView, lane: string): ResourceLaneRow | undefined =>
  view.lanes.find((row) => row.lane === lane);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'usage-proof-recipe-')));
  previousHome = process.env['HOME'];
  process.env['HOME'] = root;
  personalHome = join(root, '.codex-2');
  cmpHome = join(root, '.codex');
  runsDir = join(root, '.ashlr-runs');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  calls.paths.length = 0;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('personal usage proof recipe', () => {
  it('demonstrates a measured weekly change between two current observations', async () => {
    status(TICK, 40);
    rollout(personalHome, 'rollout-2036-10-31-a.jsonl', { at: OBS_1, sessionPct: 12, weeklyPct: 46 });

    const first = await personal();
    expect(first.code).toBe(0);
    expect(first.resource).toMatchObject({ id: 'codex-personal', state: 'current', observedAt: OBS_1,
      session: { usedPct: 12, resetsAt: `${SESSION_RESET.slice(0, 19)}.000Z` },
      // No stored history: burn and exhaustion projections stay unknown.
      weekly: { usedPct: 46, resetsAt: `${WEEKLY_RESET.slice(0, 19)}.000Z`,
        burnPctPerHour: null, projectedExhaustionAt: null } });

    const early = await ledger(['--json']);
    expect(early.code).toBe(0);
    expect(early.view.asOf).toBe(TICK);
    expect(laneOf(early.view, 'codex-personal')).toMatchObject({ running: 1, target: 1,
      usedPct: 46, source: 'codex-personal-sessions',
      observation: { source: 'codex-personal-sessions', asOf: OBS_1 } });
    // The Claude lane is weekly-only; there is no session window to confuse.
    expect(laneOf(early.view, 'claude')).toMatchObject({ window: 'weekly', usedPct: 30, source: 'status' });

    // A strictly newer provider snapshot reports a different weekly percent.
    rollout(personalHome, 'rollout-2036-10-31-b.jsonl', { at: OBS_2, sessionPct: 33, weeklyPct: 52 });
    const second = await personal();
    expect(second.code).toBe(0);
    expect(second.resource).toMatchObject({ state: 'current', observedAt: OBS_2, weekly: { usedPct: 52 } });

    // Measured change: later observation, same reset window, different percent.
    const a = first.resource;
    const b = second.resource;
    expect(Date.parse(b.observedAt!)).toBeGreaterThan(Date.parse(a.observedAt!));
    expect(b.weekly!.resetsAt).toBe(a.weekly!.resetsAt);
    expect(b.weekly!.usedPct! - a.weekly!.usedPct!).toBe(6);

    const late = await ledger(['--json']);
    expect(late.code).toBe(0);
    expect(laneOf(late.view, 'codex-personal')).toMatchObject({ usedPct: 52,
      source: 'codex-personal-sessions', observation: { asOf: OBS_2 } });

    expect(await cmdResources(['personal'])).toBe(0);
    const text = output.mock.calls.map((call) => call[0]).join('\n');
    expect(text).toContain('Freshness: current');
    expect(text).toContain('Weekly: 52% used');
  });

  it('never declares success on stale or unavailable evidence', async () => {
    status(TICK, 40);
    // A provider snapshot ~50 hours old: a last-known figure, not evidence.
    rollout(personalHome, 'rollout-2036-10-29-old.jsonl', { at: '2036-10-29T10:00:00.000Z', sessionPct: null, weeklyPct: 61 });
    const stale = await personal();
    expect(stale.code).toBe(1);
    expect(stale.resource).toMatchObject({ state: 'stale',
      observedAt: '2036-10-29T10:00:00.000Z', weekly: { usedPct: 61 } });
    await expect(cmdResources(['personal'])).resolves.toBe(1);
    expect(output.mock.calls.map((call) => call[0]).join('\n')).toContain('Freshness: stale');

    // Stale personal evidence does not displace the dispatch status value.
    const view = await ledger(['--json']);
    const lane = laneOf(view.view, 'codex-personal');
    expect(lane).toMatchObject({ usedPct: 40, source: 'status' });
    expect(lane?.observation).toBeUndefined();

    // A stale status tick fails the freshness gate with exit 1.
    const check = await ledger(['--json', '--check-fresh-seconds', '60']);
    expect(check.code).toBe(1);
    expect(check.view.freshnessCheck).toEqual({ v: 1, maxAgeSeconds: 60,
      observedAgeSeconds: 3600, result: 'stale' });

    // No usable evidence at all: unavailable, exit 1, unknown — never zero.
    rmSync(personalHome, { recursive: true, force: true });
    const missing = await personal();
    expect(missing.code).toBe(1);
    expect(missing.resource).toMatchObject({ state: 'unavailable', observedAt: null, session: null, weekly: null });
  });

  it('scopes personal evidence to the personal home and never opens credentials', async () => {
    status(TICK, 40);
    rollout(personalHome, 'rollout-2036-10-31-a.jsonl', { at: OBS_1, sessionPct: 12, weeklyPct: 46 });
    // The CMP seat next door reports different numbers and holds a credential.
    rollout(cmpHome, 'rollout-2036-10-31-cmp.jsonl', { at: OBS_2, sessionPct: 77, weeklyPct: 99 });
    writeFileSync(join(personalHome, 'auth.json'), 'fake-cmp-adjacent-credential');
    writeFileSync(join(cmpHome, 'auth.json'), 'fake-cmp-credential');
    calls.paths.length = 0;

    const first = await personal();
    expect(first.code).toBe(0);
    expect(first.resource.weekly).toMatchObject({ usedPct: 46 });
    const view = await ledger(['--json']);
    const printed = JSON.stringify(first.resource) + JSON.stringify(view.view);
    for (const leaked of ['fake-credential-value', 'fake-cmp-adjacent-credential',
      'fake-cmp-credential', 'fake-private-label', 'fake-private-project', '99']) {
      expect(printed).not.toContain(leaked);
    }
    // The CMP home was never stated, listed or opened; no auth.json was opened.
    expect(calls.paths.some((path) => path === cmpHome || path.startsWith(cmpHome + sep))).toBe(false);
    expect(calls.paths.some((path) => path.endsWith(`${sep}auth.json`) || path.endsWith('/auth.json'))).toBe(false);
  });
});
