import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const slots = JSON.stringify({ 'codex-personal': { target: 2, held: true, held_reason: 'fixture-secret' } });
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
  expect(result.lanes[0]!.verdict).toBe('held_with_capacity');
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(await readFile(path, 'utf8')).toBe(slots);
  await utimes(path, new Date(now - 3600_000), new Date(now - 3600_000));
  expect((await readLaneTruth(defaultLaneTruthReaders(home, now), now)).lanes[0]!.verdict).toBe('unknown');
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
