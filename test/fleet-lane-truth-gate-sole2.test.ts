import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneTruth, defaultLaneTruthReaders, type LaneState, type MeterSample } from '../src/cli/fleet-lane-truth.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function fixture() {
  const now = Date.now();
  const lane: LaneState = { lane: 'codex-personal', target: 2, running: 1, queued: 3, held: false, held_reason: 'fake-private-hold' };
  const sample: MeterSample = { provider: lane.lane, window: 'weekly', usedPercent: 40, sampledAt: new Date(now - 1000).toISOString(), resetAt: new Date(now + 3600_000).toISOString() };
  return { now, lane, sample };
}

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, error, output: () => String(log.mock.calls.at(-1)?.[0] ?? ''), json: () => JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
}

describe('fleet lane-truth incident gate', () => {
  it.each([
    ['held capacity', { held: true }, 'held_with_capacity'],
    ['queued without workers', { running: 0 }, 'idle_with_work'],
  ])('fails on %s and emits bounded safe reasons', async (_name, change, reason) => {
    const { lane, sample } = fixture();
    const out = capture();
    const readers = { lanes: async () => [{ ...lane, ...change }], meters: async () => [sample] };
    expect(await cmdFleetLaneTruth(['--json', '--check'], readers)).toBe(1);
    expect(out.json()).toMatchObject({ schema: 'fleet.lane-truth.v1', check: { passed: false, entries: [{ lane: lane.lane, reason }] } });
    expect(out.output()).not.toContain('fake-private-hold');
    expect(await cmdFleetLaneTruth(['--check'], readers)).toBe(1);
    expect(out.output()).toContain(reason === 'held_with_capacity' ? 'investigate the hold' : 'investigate the stall');
    expect(out.output()).not.toContain('fake-private-hold');
  });

  it('passes fresh reset and ok evidence, but fails stale or failed meter reads', async () => {
    const { now, lane, sample } = fixture();
    const out = capture();
    const previous = { ...sample, usedPercent: 70, sampledAt: new Date(now - 60_000).toISOString() };
    const readers = { lanes: async () => [lane], meters: async () => [sample, previous] };
    expect(await cmdFleetLaneTruth(['--check', '--json'], readers)).toBe(0);
    expect(out.json()).toMatchObject({ lanes: [{ verdict: 'reset_detected' }], check: { passed: true, entries: [] } });
    expect(await cmdFleetLaneTruth(['--check', '--json'], { ...readers, meters: async () => [sample] })).toBe(0);
    expect(out.json().lanes[0].verdict).toBe('ok');
    expect(await cmdFleetLaneTruth(['--check', '--json'], { ...readers, meters: async () => [{ ...sample, sampledAt: new Date(now - 3600_000).toISOString() }] })).toBe(1);
    expect(out.json().check.entries).toEqual([{ lane: lane.lane, reason: 'unknown' }]);
    expect(await cmdFleetLaneTruth(['--check', '--json'], { ...readers, meters: async () => { throw new Error('fake-secret-path'); } })).toBe(1);
    expect(out.output()).not.toContain('fake-secret-path');
  });

  it('fails empty and missing selections even with a healthy different lane', async () => {
    const { lane, sample } = fixture();
    const out = capture();
    expect(await cmdFleetLaneTruth(['--check', '--json'], { lanes: async () => [], meters: async () => [] })).toBe(1);
    expect(out.json().check.entries).toEqual([{ lane: null, reason: 'empty_evidence' }]);
    const readers = { lanes: async () => [lane], meters: async () => [sample] };
    expect(await cmdFleetLaneTruth(['--lane', 'missing-lane', '--json', '--check'], readers)).toBe(1);
    expect(out.json()).toMatchObject({ lanes: [], check: { passed: false, entries: [{ lane: 'missing-lane', reason: 'missing_lane' }] } });
    expect(await cmdFleetLaneTruth(['--lane', lane.lane, '--lane', 'missing-lane', '--check', '--json'], readers)).toBe(1);
    expect(out.json().check.entries).toEqual([{ lane: 'missing-lane', reason: 'missing_lane' }]);
    expect(await cmdFleetLaneTruth(['--lane', 'missing-lane', '--check'], readers)).toBe(1);
    expect(out.output()).toContain('missing-lane: requested lane is missing');
  });

  it('uses a deduplicated union and does not let a healthy lane mask an unknown lane', async () => {
    const { lane, sample } = fixture();
    const out = capture();
    const readers = { lanes: async () => [lane, { ...lane, lane: 'stale-lane' }, { ...lane, lane: 'other-lane' }], meters: async () => [sample] };
    expect(await cmdFleetLaneTruth(['--lane', lane.lane, '--lane', 'stale-lane', '--lane', lane.lane, '--check', '--json'], readers)).toBe(1);
    expect(out.json().lanes.map((row: LaneState) => row.lane)).toEqual([lane.lane, 'stale-lane']);
    expect(out.json().check.entries).toEqual([{ lane: 'stale-lane', reason: 'unknown' }]);
    expect(await cmdFleetLaneTruth(['--lane', lane.lane, '--lane', lane.lane, '--json', '--check'], readers)).toBe(0);
    expect(out.json().lanes).toHaveLength(1);
  });

  it('bounds failure entries without losing any requested missing lane', async () => {
    const { lane } = fixture();
    const out = capture();
    const readers = { lanes: async () => Array.from({ length: 300 }, () => lane), meters: async () => [] };
    expect(await cmdFleetLaneTruth(['--lane', lane.lane, '--lane', 'missing-lane', '--json', '--check'], readers)).toBe(1);
    expect(out.json().check.entries).toHaveLength(257);
    expect(out.json().check.entries[0]).toEqual({ lane: 'missing-lane', reason: 'missing_lane' });
    expect(out.json().check.entries.at(-1)).toEqual({ lane: null, reason: 'too_many_lanes' });
  });

  it('retains ordinary output and exits, including unknown, empty and read failure', async () => {
    const { lane } = fixture();
    const out = capture();
    expect(await cmdFleetLaneTruth(['--json'], { lanes: async () => [lane], meters: async () => [] })).toBe(0);
    expect(out.json()).toEqual({ schema: 'fleet.lane-truth.v1', lanes: [{ lane: lane.lane, target: 2, running: 1, queued: 3, held: false, verdict: 'unknown' }] });
    expect(await cmdFleetLaneTruth([], { lanes: async () => [], meters: async () => [] })).toBe(0);
    expect(out.output()).toBe('');
    const broken = { lanes: async (): Promise<LaneState[]> => { throw new Error('fake-secret-path'); }, meters: async () => [] };
    expect(await cmdFleetLaneTruth(['--check', '--json', '--lane', lane.lane], broken)).toBe(1);
    expect(out.json().check.entries).toEqual([{ lane: lane.lane, reason: 'evidence_unavailable' }]);
    expect(out.output()).not.toContain('fake-secret-path');
    expect(await cmdFleetLaneTruth([], broken)).toBe(1);
    expect(out.error).toHaveBeenCalledWith('fleet lane-truth: lane evidence unavailable');
  });

  it('rejects malformed and duplicate singleton flags before reading', async () => {
    const lanes = vi.fn(async () => []);
    const readers = { lanes, meters: async () => [] };
    const out = capture();
    for (const args of [['--json', '--json'], ['--check', '--check'], ['--lane'], ['--lane', '--json'], ['--lane', '../fake'], ['--lane=valid'], ['--wat'], ['--help', '--check']]) {
      expect(await cmdFleetLaneTruth(args, readers)).toBe(2);
    }
    expect(lanes).not.toHaveBeenCalled();
    expect(await cmdFleetLaneTruth(['--help'], readers)).toBe(0);
    expect(out.output()).toContain('reset_detected is advisory');
    expect(out.output()).toContain('never releases holds or grants dispatch authority');
  });

  it('integrates the default readers against a fake filesystem home without writes', async () => {
    const { now, sample } = fixture();
    const home = await mkdtemp(join(tmpdir(), 'lane-gate-fake-')); dirs.push(home);
    const queue = join(home, '.ashlr-runs', 'queue');
    const sessions = join(home, '.codex-2', 'sessions', '2026', '10', '31');
    await mkdir(queue, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const slots = JSON.stringify({ lanes: { 'codex-personal': { target: 2, running: 0, queued: 4, held: false, held_reason: 'fake-private-hold' } } });
    const event = JSON.stringify({ timestamp: sample.sampledAt, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor((now + 3600_000) / 1000) }, account: 'fake-private-account' }, command: 'fake-private-command' } });
    const slotsPath = join(queue, 'slots.json');
    const rolloutPath = join(sessions, 'rollout-fake.jsonl');
    await writeFile(slotsPath, slots);
    await writeFile(rolloutPath, event);
    const out = capture();
    expect(await cmdFleetLaneTruth(['--lane', 'codex-personal', '--json', '--check'], defaultLaneTruthReaders(home))).toBe(1);
    expect(out.json()).toMatchObject({ lanes: [{ verdict: 'idle_with_work' }], check: { passed: false, entries: [{ lane: 'codex-personal', reason: 'idle_with_work' }] } });
    expect(out.output()).not.toMatch(/fake-private|lane-gate-fake/);
    expect(await readFile(slotsPath, 'utf8')).toBe(slots);
    expect(await readFile(rolloutPath, 'utf8')).toBe(event);
  });
});
