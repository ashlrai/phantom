import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLaneTruthReport } from '../src/core/fleet/lane-truth.js';
import { cmdFleetLaneTruth, defaultLaneTruthReaders, readLaneTruth, type LaneState, type MeterSample } from '../src/cli/fleet-lane-truth.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane: LaneState = { lane: 'codex-personal', target: 2, running: 1, queued: 3, held: false };
const sample: MeterSample = { provider: lane.lane, window: 'weekly', usedPercent: 60, resetAt: '2026-11-01T12:00:00Z', sampledAt: '2026-10-31T11:59:00Z' };
const verdict = async (state: Partial<LaneState> = {}, samples = [sample]) => (await readLaneTruth({ lanes: async () => [{ ...lane, ...state }], meters: async () => samples }, now)).lanes[0]!.verdict;
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('lane truth fixtures', () => {
  it('detects a personal lane held at zero despite a guessed hold expiry', async () => {
    expect(await verdict({ held: true, held_until: '2026-11-01T20:00:00Z', held_reason: 'guessed expiry' }, [{ ...sample, usedPercent: 0 }])).toBe('held_with_capacity');
  });
  it('detects a drop of exactly twenty percentage points', async () => {
    expect(await verdict({}, [{ ...sample, usedPercent: 40 }, { ...sample, sampledAt: '2026-10-31T11:55:00Z' }])).toBe('reset_detected');
  });
  it('detects a reset moving later without a percent drop', async () => {
    expect(await verdict({}, [sample, { ...sample, resetAt: '2026-11-01T11:00:00Z', sampledAt: '2026-10-31T11:55:00Z' }])).toBe('reset_detected');
  });
  it.each([
    ['2026-10-31T11:54:59Z', 'idle_with_work'],
    ['2026-10-31T11:55:00Z', 'idle_with_work'],
    ['2026-10-31T11:55:01Z', 'reset_detected'],
  ])('qualifies a previous window ending at %s against its observation time', async (resetAt, expected) => {
    const previous = { ...sample, resetAt, sampledAt: '2026-10-31T11:55:00Z' };
    expect(await verdict({ running: 0 }, [previous, sample])).toBe(expected);
  });
  it('detects idle work and ordinary activity', async () => {
    expect(await verdict({ running: 0 })).toBe('idle_with_work');
    expect(await verdict()).toBe('ok');
    expect(await verdict({ held: true }, [{ ...sample, usedPercent: 95 }])).toBe('ok');
  });
  it.each([
    [], [{ ...sample, usedPercent: null }], [{ ...sample, usedPercent: 101 }],
    [{ ...sample, sampledAt: '2026-10-31T11:00:00Z' }],
    [{ ...sample, sampledAt: '2026-10-31T12:01:00Z' }],
    [{ ...sample, resetAt: null }], [{ ...sample, resetAt: '2026-10-31T11:00:00Z' }],
    [{ ...sample, provider: 'codex-cmp' }],
  ])('keeps missing, invalid, stale or other-account evidence unknown (%#)', async (...samples) => {
    expect(await verdict({}, samples as MeterSample[])).toBe('unknown');
  });
  it('requires all observed windows and does not compare different windows', async () => {
    expect(await verdict({}, [sample, { ...sample, window: 'session', usedPercent: null }])).toBe('unknown');
    expect(await verdict({}, [sample, { ...sample, window: 'session', usedPercent: 90, sampledAt: '2026-10-31T11:55:00Z' }])).toBe('ok');
    expect(await verdict({ running: null })).toBe('unknown');
    expect(await verdict({ held: null })).toBe('unknown');
  });
  it('does not infer reset from equal timestamps or stale history', async () => {
    expect(await verdict({}, [sample, { ...sample, usedPercent: 90 }])).toBe('ok');
    expect(await verdict({}, [sample, { ...sample, usedPercent: 90, sampledAt: '2026-10-31T10:00:00Z' }])).toBe('ok');
  });
  it('compares against the latest usable prior reading when an invalid sample intervenes', async () => {
    const beforeReset = {
      ...sample, sampledAt: '2026-10-31T11:55:00Z', resetAt: '2026-10-31T11:56:00Z', usedPercent: 100,
    };
    const afterExpiry = { ...beforeReset, sampledAt: '2026-10-31T11:57:00Z' };
    expect(await verdict({ running: 0 }, [afterExpiry, sample, beforeReset])).toBe('reset_detected');
    expect(await verdict({ running: 0 }, [beforeReset, afterExpiry])).toBe('unknown');
    expect(await verdict({ running: 0 }, [
      { ...beforeReset, sampledAt: '2026-10-31T11:00:00Z' }, afterExpiry, sample,
    ])).toBe('idle_with_work');
  });
  it('uses dated observations when an unreadable timestamp interrupts the journal', async () => {
    const older = { ...sample, usedPercent: 85, sampledAt: '2026-10-31T11:55:00Z' };
    const undated = { ...sample, sampledAt: 'unreadable' };
    expect(await verdict({}, [older, undated, sample])).toBe('reset_detected');
    expect(await verdict({}, [undated, older, sample])).toBe('reset_detected');
    expect(await verdict({}, [sample, { ...undated, window: 'session' }])).toBe('unknown');
  });
  it('uses quota evidence available at report time for the verdict and wire meter', async () => {
    const current = { ...sample, sampledAt: new Date(now).toISOString() };
    const future = { ...sample, sampledAt: new Date(now + 1000).toISOString(), usedPercent: 100 };
    const lanes = async () => [{ ...lane, running: 0 }];
    expect(await readLaneTruthReport({ lanes, meters: async () => [future, current] }, now))
      .toMatchObject([{ verdict: 'idle_with_work', meter: { sampledAt: current.sampledAt, usedPercent: 60 } }]);
    expect(await readLaneTruthReport({ lanes, meters: async () => [future] }, now))
      .toMatchObject([{ verdict: 'unknown', meter: null }]);
    expect(await verdict({ running: 0 }, [current, { ...future, window: 'session' }])).toBe('unknown');
  });
  it('emits one row per lane and strips untrusted metadata', async () => {
    const result = await readLaneTruth({ lanes: async () => [lane, { ...lane, lane: 'claude', held_reason: 'fixture-secret' }], meters: async () => [sample] }, now);
    expect(result.lanes.map(row => row.verdict)).toEqual(['ok', 'unknown']);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('degrades a failed provider reader', async () => {
    expect((await readLaneTruth({ lanes: async () => [lane], meters: async () => { throw new Error('fixture-secret'); } }, now)).lanes[0]!.verdict).toBe('unknown');
  });
});

it('reads newest personal rollout only, ignores the company home, and writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lane-truth-')); dirs.push(home);
  const queue = join(home, '.ashlr-runs/queue');
  const sessions = join(home, '.codex-2/sessions/2026/10/31');
  await mkdir(queue, { recursive: true }); await mkdir(sessions, { recursive: true });
  const slots = JSON.stringify({ 'codex-personal': { target: 2, running: 0, queued: 4, held: true, held_reason: 'fixture-secret' } });
  const path = join(queue, 'slots.json');
  await writeFile(path, slots); await utimes(path, new Date(now), new Date(now));
  const event = (used: number, timestamp: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: used, window_minutes: 10080, resets_at: Date.parse(sample.resetAt!) / 1000 }, credits: { secret: 'fixture-secret' } } } });
  await writeFile(join(sessions, 'rollout-old.jsonl'), event(99, sample.sampledAt));
  await utimes(join(sessions, 'rollout-old.jsonl'), new Date(now - 1000), new Date(now - 1000));
  await writeFile(join(sessions, 'rollout-new.jsonl'), `${event(80, '2026-10-31T11:55:00Z')}\nmalformed\n${event(0, sample.sampledAt)}\n`);
  await utimes(join(sessions, 'rollout-new.jsonl'), new Date(now), new Date(now));
  await mkdir(join(home, '.codex/sessions'), { recursive: true });
  await writeFile(join(home, '.codex/sessions/rollout-company.jsonl'), event(100, sample.sampledAt));
  const result = await readLaneTruth(defaultLaneTruthReaders(home, now), now);
  expect(result.lanes).toEqual([{ lane: lane.lane, target: 2, running: 0, queued: 4, held: true, verdict: 'held_with_capacity' }]);
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(await readFile(path, 'utf8')).toBe(slots);
  for (const timestamp of [now - 3600_000, now + 1000]) {
    const mtime = new Date(timestamp);
    await utimes(path, mtime, mtime);
    const readers = defaultLaneTruthReaders(home, now);
    const expected = { lane: lane.lane, target: 2, running: null, queued: null, held: null, verdict: 'unknown' };
    expect((await readLaneTruth(readers, now)).lanes).toEqual([expected]);
    expect(await readLaneTruthReport(readers, now)).toMatchObject([expected]);
  }
});

it('preserves the rollout when one reading has an out-of-range reset', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lane-truth-reset-')); dirs.push(home);
  const sessions = join(home, '.codex-2/sessions/2026/10/31');
  await mkdir(sessions, { recursive: true });
  const rollout = join(sessions, 'rollout-test.jsonl');
  const event = (timestamp: string, reset: number) => JSON.stringify({
    timestamp, type: 'event_msg', payload: {
      type: 'token_count', rate_limits: { secondary: { used_percent: 60, window_minutes: 10080, resets_at: reset } },
    },
  });
  const valid = event(sample.sampledAt, Date.parse(sample.resetAt!) / 1000);
  const malformed = event('2026-10-31T11:58:00Z', 9_000_000_000_000);
  const readers = { ...defaultLaneTruthReaders(home, now), lanes: async () => [lane] };

  await writeFile(rollout, [malformed, valid].join('\n'));
  expect((await readers.meters()).map(reading => reading.resetAt)).toEqual([null, '2026-11-01T12:00:00.000Z']);
  expect((await readLaneTruth(readers, now)).lanes[0]!.verdict).toBe('ok');

  await writeFile(rollout, [valid, event('2026-10-31T12:00:00Z', 9_000_000_000_000)].join('\n'));
  expect((await readLaneTruth(readers, now)).lanes[0]!.verdict).toBe('unknown');
});

it('falls back past rollouts without a quota observation available at report time', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lane-truth-observed-')); dirs.push(home);
  const sessions = join(home, '.codex-2/sessions/2026/10/31');
  await mkdir(sessions, { recursive: true });
  const event = (timestamp: string, usedPercent: number) => JSON.stringify({
    timestamp, type: 'event_msg', payload: {
      type: 'token_count', rate_limits: {
        secondary: { used_percent: usedPercent, window_minutes: 10080, resets_at: Date.parse(sample.resetAt!) / 1000 },
      },
    },
  });
  const older = join(sessions, 'rollout-older.jsonl');
  const newest = join(sessions, 'rollout-newest.jsonl');
  await writeFile(older, event(sample.sampledAt, 60));
  await utimes(older, new Date(now - 1000), new Date(now - 1000));
  await writeFile(newest, [event('unreadable', 100), event(new Date(now + 1000).toISOString(), 100)].join('\n'));
  await utimes(newest, new Date(now), new Date(now));
  const readers = { ...defaultLaneTruthReaders(home, now), lanes: async () => [{ ...lane, running: 0 }] };

  expect(await readLaneTruthReport(readers, now)).toMatchObject([
    { verdict: 'idle_with_work', meter: { sampledAt: new Date(sample.sampledAt).toISOString(), usedPercent: 60 } },
  ]);
  await rm(older);
  expect(await readLaneTruthReport(readers, now)).toMatchObject([{ verdict: 'unknown', meter: null }]);
});

it('validates CLI options before reading and emits JSON', async () => {
  const lanes = vi.fn(async () => [lane]);
  const readers = { lanes, meters: async () => [sample] };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetLaneTruth(['--watch'], readers)).toBe(2);
  expect(lanes).not.toHaveBeenCalled();
  expect(await cmdFleetLaneTruth(['--help'], readers)).toBe(0);
  expect(lanes).not.toHaveBeenCalled();
  expect(await cmdFleetLaneTruth(['--json'], readers)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'fleet.lane-truth.v1', lanes: [{ lane: 'codex-personal' }] });
});

it('refuses a personal-home symlink into the company home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lane-truth-link-')); dirs.push(home);
  await mkdir(join(home, '.codex/sessions'), { recursive: true });
  await symlink(join(home, '.codex'), join(home, '.codex-2'));
  expect(await defaultLaneTruthReaders(home, now).meters()).toEqual([]);
});

it('the default lanes reader honors ASHLR_RUNS_DIR under the real home only', async () => {
  const runs = await mkdtemp(join(tmpdir(), 'lane-truth-runs-')); dirs.push(runs);
  const relocated = await mkdtemp(join(tmpdir(), 'lane-truth-fixture-')); dirs.push(relocated);
  const queue = join(runs, 'queue');
  await mkdir(queue, { recursive: true });
  const slots = JSON.stringify({ 'codex-personal': { target: 2, running: 1, queued: 3, held: false } });
  const path = join(queue, 'slots.json');
  await writeFile(path, slots);
  const mtime = new Date(now);
  await utimes(path, mtime, mtime);
  const previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runs;
  try {
    // No-arg readers resolve the process home, so the override applies.
    expect(await defaultLaneTruthReaders(undefined, now).lanes()).toEqual([
      { lane: 'codex-personal', target: 2, running: 1, queued: 3, held: false },
    ]);
    // A relocated home keeps its own .ashlr-runs; the override cannot leak in.
    expect(await defaultLaneTruthReaders(relocated, now).lanes()).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
    else process.env.ASHLR_RUNS_DIR = previous;
  }
  expect(await readFile(path, 'utf8')).toBe(slots);
});
