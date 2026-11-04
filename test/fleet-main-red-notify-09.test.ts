/**
 * RQ-PHX-MAINREDNOTIFY09 — `ashlr fleet main-red-notify`: one notice when a
 * repo's main turns red, one when it recovers, no repeats. All state lives
 * under a temp runs dir; senders are plainly fake.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetMainRedNotify } from '../src/cli/fleet-main-red-notify.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  MAIN_RED_NOTIFY_STATE, planMainRedNotices, readMainRedNotifyState,
} from '../src/core/fleet/main-red-notify.js';
import type { FleetMainHealthRepo, FleetMainHealthV1 } from '../src/core/fleet/main-health.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'main-red-notify-')); dirs.push(dir); return dir; };

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const row = (over: Partial<FleetMainHealthRepo>): FleetMainHealthRepo => ({
  repo: 'example/demo', branch: 'main', sha: null, state: 'green', checkedAt: null,
  failingCheck: null, fixJobs: [], nightlyRed: null, ...over,
});
const health = (repos: FleetMainHealthRepo[], over: Partial<FleetMainHealthV1> = {}): FleetMainHealthV1 => ({
  v: 1, generatedAt: '2026-11-04T12:00:00.000Z', source: 'ok', statusAt: '2026-11-04T11:59:00.000Z',
  stale: false, guardianOff: false, red: repos.filter(r => r.state === 'red').length, repos, ...over,
});
// eslint-disable-next-line no-control-regex -- asserting the output has none.
const CONTROL = /[\x00-\x1f\x7f]/;
const statePath = (dir: string): string => join(dir, MAIN_RED_NOTIFY_STATE);
const seedState = (dir: string, state: Record<string, 'red' | 'green'>): void => {
  mkdirSync(dirname(statePath(dir)), { recursive: true });
  writeFileSync(statePath(dir), `${JSON.stringify(state)}\n`, { mode: 0o600 });
};

const fakeSenders = () => {
  const sent: { channel: string; text: string }[] = [];
  return {
    sent,
    senders: {
      email: async (text: string) => { sent.push({ channel: 'email', text }); },
      telegram: async (text: string) => { sent.push({ channel: 'telegram', text }); return { ok: true }; },
    },
  };
};

describe('planMainRedNotices', () => {
  it('green to red sends one notice; red to red sends none; red to green sends a recovery', () => {
    const red = health([row({ state: 'red', failingCheck: 'build', fixJobs: ['job-1'] })]);
    const first = planMainRedNotices({ 'example/demo': 'green' }, red, NOW);
    expect(first.notices).toEqual([
      { repo: 'example/demo', kind: 'red', text: 'Main red on example/demo: build. Fix job: job-1.' },
    ]);
    expect(first.next).toEqual({ 'example/demo': 'red' });
    expect(planMainRedNotices(first.next, red, NOW).notices).toEqual([]);
    const recovered = planMainRedNotices(first.next, health([row({})]), NOW);
    expect(recovered.notices).toEqual([{ repo: 'example/demo', kind: 'recovered', text: 'Main green again on example/demo.' }]);
    expect(recovered.next).toEqual({ 'example/demo': 'green' });
  });

  it('unknown, stale or unavailable health sends nothing and leaves state unchanged', () => {
    const prev = { 'example/demo': 'red' as const };
    const unknown = planMainRedNotices(prev, health([row({ state: 'unknown' })]), NOW);
    const stale = planMainRedNotices(prev, health([row({ state: 'green' })], { stale: true }), NOW);
    const gone = planMainRedNotices(prev, health([], { source: 'unavailable', stale: true }), NOW);
    for (const plan of [unknown, stale, gone]) {
      expect(plan.notices).toEqual([]);
      expect(plan.next).toEqual(prev);
    }
  });

  it('a first run records every state and notifies only red repos', () => {
    const plan = planMainRedNotices({}, health([
      row({ repo: 'example/demo', state: 'red', failingCheck: 'lint' }),
      row({ repo: 'example/other', state: 'green' }),
      row({ repo: 'example/mystery', state: 'unknown' }),
    ]), NOW);
    expect(plan.notices).toEqual([
      { repo: 'example/demo', kind: 'red', text: 'Main red on example/demo: lint. Fix job: none yet.' },
    ]);
    expect(plan.next).toEqual({ 'example/demo': 'red', 'example/other': 'green' });
  });

  it('notice text carries no control characters and is at most 300 characters', () => {
    const nasty = 'demo\u0007\nrepo';
    const plan = planMainRedNotices({}, health([row({
      repo: `example/${nasty}`, state: 'red',
      failingCheck: `check-\u001b[31m${'x'.repeat(400)}`, fixJobs: [`fix-${'y'.repeat(200)}`],
    })]), NOW);
    expect(plan.notices).toHaveLength(1);
    const text = plan.notices[0]!.text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toMatch(CONTROL);
    expect(plan.notices[0]!.repo).not.toMatch(CONTROL);
  });
});

describe('cmdFleetMainRedNotify', () => {
  const silent = { output: () => {}, error: () => {} };

  it('sends one email and one telegram on the red transition, then stays quiet', async () => {
    const dir = root();
    const { senders, sent } = fakeSenders();
    const readHealth = async () => health([row({ state: 'red', failingCheck: 'build' })]);
    const code = await cmdFleetMainRedNotify([], { ...silent, runsDir: dir, now: () => NOW, readHealth, senders });
    expect(code).toBe(0);
    expect(sent).toEqual([
      { channel: 'email', text: 'Main red on example/demo: build. Fix job: none yet.' },
      { channel: 'telegram', text: 'Main red on example/demo: build. Fix job: none yet.' },
    ]);
    expect(readMainRedNotifyState(dir)).toEqual({ 'example/demo': 'red' });
    // Same health again: red-to-red is no transition, nothing else is sent.
    await cmdFleetMainRedNotify([], { ...silent, runsDir: dir, now: () => NOW, readHealth, senders });
    expect(sent).toHaveLength(2);
  });

  it('sends the recovery notice when the repo goes green again', async () => {
    const dir = root();
    seedState(dir, { 'example/demo': 'red' });
    const { senders, sent } = fakeSenders();
    const code = await cmdFleetMainRedNotify(['--json'], {
      ...silent, runsDir: dir, now: () => NOW, senders,
      readHealth: async () => health([row({})]),
      output: () => {},
    });
    expect(code).toBe(0);
    expect(sent.map(s => s.text)).toEqual(['Main green again on example/demo.', 'Main green again on example/demo.']);
    expect(readMainRedNotifyState(dir)).toEqual({ 'example/demo': 'green' });
  });

  it('--json prints schema, notices and sent counts', async () => {
    const dir = root();
    const { senders } = fakeSenders();
    const lines: string[] = [];
    const code = await cmdFleetMainRedNotify(['--json'], {
      output: t => lines.push(t), error: () => {}, runsDir: dir, now: () => NOW, senders,
      readHealth: async () => health([row({ state: 'red', failingCheck: 'build' })]),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema).toBe('fleet.main-red-notify.v1');
    expect(parsed.notices).toHaveLength(1);
    expect(parsed.sent).toEqual({ attempted: 2, ok: 2, failed: 0 });
  });

  it('--dry-run prints the notices and writes and sends nothing', async () => {
    const dir = root();
    const { senders, sent } = fakeSenders();
    const lines: string[] = [];
    const code = await cmdFleetMainRedNotify(['--dry-run'], {
      output: t => lines.push(t), error: () => {}, runsDir: dir, now: () => NOW, senders,
      readHealth: async () => health([row({ state: 'red', failingCheck: 'build' })]),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Main red on example/demo: build.');
    expect(sent).toEqual([]);
    expect(existsSync(statePath(dir))).toBe(false);
  });

  it('a telegram send that throws gives exit 0, failed 1, and the state is still saved', async () => {
    const dir = root();
    const lines: string[] = [];
    const code = await cmdFleetMainRedNotify(['--json'], {
      output: t => lines.push(t), error: () => {}, runsDir: dir, now: () => NOW,
      senders: {
        email: async () => {},
        telegram: async () => { throw new Error('fake telegram down'); },
      },
      readHealth: async () => health([row({ state: 'red', failingCheck: 'build' })]),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).sent).toEqual({ attempted: 2, ok: 1, failed: 1 });
    expect(readMainRedNotifyState(dir)).toEqual({ 'example/demo': 'red' });
  });

  it('bad args give exit 2 with no reads', async () => {
    const dir = root();
    let reads = 0;
    const deps = {
      output: () => {}, error: () => {}, runsDir: dir,
      readHealth: async () => { reads++; return health([]); },
      readState: () => { reads++; return {}; },
    };
    expect(await cmdFleetMainRedNotify(['--bogus'], deps)).toBe(2);
    expect(await cmdFleetMainRedNotify(['--json', '--xml'], deps)).toBe(2);
    expect(reads).toBe(0);
    expect(existsSync(statePath(dir))).toBe(false);
  });

  it('the registry loader resolves cmdFleetMainRedNotify', async () => {
    expect(typeof FLEET_SUBCOMMAND_LOADERS['main-red-notify']).toBe('function');
    const loaded = await FLEET_SUBCOMMAND_LOADERS['main-red-notify']!();
    expect(loaded.cmdFleetMainRedNotify).toBe(cmdFleetMainRedNotify);
  });

  it('an unreadable state file counts as empty state', () => {
    const dir = root();
    mkdirSync(dirname(statePath(dir)), { recursive: true });
    writeFileSync(statePath(dir), 'not json {');
    expect(readMainRedNotifyState(dir)).toEqual({});
    writeFileSync(statePath(dir), JSON.stringify({ 'example/demo': 'red', junk: 'blue' }));
    expect(readMainRedNotifyState(dir)).toEqual({ 'example/demo': 'red' });
  });
});
