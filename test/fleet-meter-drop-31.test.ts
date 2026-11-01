import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetMeterDrop, readMeterDrop } from '../src/cli/fleet-meter-drop.js';
import { defaultLaneTruthReaders, type LaneState, type MeterSample } from '../src/cli/fleet-lane-truth.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane: LaneState = { lane: 'codex-personal', target: 2, running: 12, queued: 0, held: false };
const earlier: MeterSample = { provider: 'codex-personal', window: 'secondary:10080', usedPercent: 40, resetAt: '2026-11-06T12:00:00Z', sampledAt: '2026-10-31T11:00:00Z' };
const later: MeterSample = { ...earlier, sampledAt: '2026-10-31T12:00:00Z' };
const report = async (state: Partial<LaneState> | null = {}, samples: MeterSample[] = [earlier, later]) =>
  readMeterDrop({ lanes: async () => state === null ? [] : [{ ...lane, ...state }], meters: async () => samples }, now);
const verdict = async (state: Partial<LaneState> | null = {}, samples: MeterSample[] = [earlier, later]) =>
  (await report(state, samples)).providers[0]!.verdict;
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('meter drop verdicts', () => {
  it('flags a meter unchanged after sixty minutes with twelve running jobs', async () => {
    const row = (await report()).providers[0]!;
    expect(row.verdict).toBe('flat_with_work');
    expect(row.running).toBe(12);
    expect(row.windows[0]).toMatchObject({ delta: 0, observedMinutes: 60, stale: false });
  });
  it('reports motion on any percent change, including a reset drop', async () => {
    expect(await verdict({}, [earlier, { ...later, usedPercent: 65 }])).toBe('moving');
    expect(await verdict({}, [earlier, { ...later, usedPercent: 5, resetAt: '2026-11-07T12:00:00Z' }])).toBe('moving');
  });
  it('reports a flat meter without running work as idle', async () => {
    expect(await verdict({ running: 0 })).toBe('flat_idle');
    expect(await verdict({ running: 0, queued: 9 })).toBe('flat_idle');
  });
  it('keeps missing evidence unknown, never moving', async () => {
    expect(await verdict({}, [])).toBe('unknown');
    expect(await verdict({}, [earlier])).toBe('unknown');
    expect(await verdict({}, [{ ...earlier, usedPercent: null }, later])).toBe('unknown');
    expect(await verdict(null)).toBe('unknown');
  });
  it('keeps ambiguous or stale evidence unknown, never moving', async () => {
    expect(await verdict({}, [earlier, { ...later, sampledAt: earlier.sampledAt }])).toBe('unknown');
    expect(await verdict({}, [earlier, { ...earlier, usedPercent: 70 }])).toBe('unknown');
    expect(await verdict({}, [earlier, { ...later, usedPercent: 101 }])).toBe('unknown');
    expect(await verdict({}, [earlier, { ...later, sampledAt: 'not-a-date' }])).toBe('unknown');
    expect(await verdict({}, [earlier, { ...later, sampledAt: '2026-10-31T12:30:00Z' }])).toBe('unknown');
    expect(await verdict({}, [earlier, { ...later, sampledAt: '2026-10-31T11:44:00Z' }])).toBe('unknown');
  });
  it('requires every observed window to resolve before a flat or moving call', async () => {
    const primary = { window: 'primary:300' };
    expect(await verdict({}, [earlier, { ...later, usedPercent: 55 }, { ...earlier, ...primary }, { ...later, ...primary }])).toBe('moving');
    expect(await verdict({}, [earlier, later, { ...earlier, ...primary }])).toBe('unknown');
    expect(await verdict({}, [earlier, later, { ...earlier, ...primary, usedPercent: null }])).toBe('unknown');
  });
  it('needs proven work for an incident and proven quiet for idle', async () => {
    expect(await verdict({ running: null })).toBe('unknown');
    expect(await verdict({ running: 'many' as never })).toBe('unknown');
    expect(await verdict({ running: 0 }, [earlier, { ...later, usedPercent: 50 }])).toBe('moving');
  });
  it('keeps a moved meter moving when lane evidence is lost', async () => {
    expect((await readMeterDrop({ lanes: async () => { throw new Error('fixture-secret'); }, meters: async () => [earlier, { ...later, usedPercent: 55 }] }, now)).providers[0]!.verdict).toBe('moving');
    expect((await readMeterDrop({ lanes: async () => { throw new Error('fixture-secret'); }, meters: async () => [earlier, later] }, now)).providers[0]!.verdict).toBe('unknown');
    expect((await readMeterDrop({ lanes: async () => [lane], meters: async () => { throw new Error('fixture-secret'); } }, now)).providers[0]!.verdict).toBe('unknown');
  });
  it('ranks incidents first and counts them', async () => {
    const lanes: LaneState[] = [
      { ...lane, lane: 'claude-max', running: 0 },
      { ...lane, lane: 'codex-cmp', running: 4 },
      { ...lane, lane: 'grok-ultra', running: 1 },
    ];
    const samples: MeterSample[] = [
      { ...earlier, provider: 'claude-max' }, { ...later, provider: 'claude-max' },
      { ...earlier, provider: 'codex-cmp' }, { ...later, provider: 'codex-cmp' },
      { ...earlier, provider: 'grok-ultra' }, { ...later, provider: 'grok-ultra', usedPercent: 44 },
      { ...earlier, provider: 'terra' },
    ];
    const result = await readMeterDrop({ lanes: async () => lanes, meters: async () => samples }, now);
    expect(result.providers.map(row => row.provider)).toEqual(['codex-cmp', 'terra', 'claude-max', 'grok-ultra']);
    expect(result.providers.map(row => row.verdict)).toEqual(['flat_with_work', 'unknown', 'flat_idle', 'moving']);
    expect(result.incidents).toBe(1);
  });
  it('strips untrusted provider and window names from the report', async () => {
    const dirty = { ...earlier, provider: 'Codex Personal!!', window: 'secret window !!' };
    const result = await readMeterDrop({ lanes: async () => [{ ...lane, lane: 'Codex Personal!!' }], meters: async () => [dirty, { ...later, provider: 'Codex Personal!!' }] }, now);
    expect(result.providers[0]!.provider).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('secret window');
  });
});

it('reads the newest personal rollout for two timed samples and writes nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'meter-drop-')); dirs.push(home);
  const queue = join(home, '.ashlr-runs/queue');
  const sessions = join(home, '.codex-2/sessions/2026/10/31');
  await mkdir(queue, { recursive: true }); await mkdir(sessions, { recursive: true });
  const slots = JSON.stringify({ 'codex-personal': { target: 2, running: 12, queued: 0, held: false } });
  const path = join(queue, 'slots.json');
  await writeFile(path, slots); await utimes(path, new Date(now), new Date(now));
  const event = (used: number, timestamp: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: used, window_minutes: 10080, resets_at: Date.parse(earlier.resetAt!) / 1000 }, credits: { secret: 'fixture-secret' } } } });
  await writeFile(join(sessions, 'rollout-new.jsonl'), `${event(40, earlier.sampledAt)}\nmalformed\n${event(40, later.sampledAt)}\n`);
  await utimes(join(sessions, 'rollout-new.jsonl'), new Date(now), new Date(now));
  const result = await readMeterDrop(defaultLaneTruthReaders(home, now), now);
  expect(result.providers).toHaveLength(1);
  expect(result.providers[0]).toMatchObject({ provider: 'codex-personal', running: 12, verdict: 'flat_with_work' });
  expect(result.providers[0]!.windows[0]).toMatchObject({ window: 'secondary:10080', delta: 0, observedMinutes: 60 });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(await readFile(path, 'utf8')).toBe(slots);
});

it('validates CLI options before reading and emits JSON or plain verdicts', async () => {
  const lanes = vi.fn(async () => [lane]);
  const readers = { lanes, meters: async () => [earlier, later] };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetMeterDrop(['--watch'], readers, now)).toBe(2);
  expect(await cmdFleetMeterDrop(['--json', '--json'], readers, now)).toBe(2);
  expect(lanes).not.toHaveBeenCalled();
  expect(await cmdFleetMeterDrop(['--help'], readers, now)).toBe(0);
  expect(lanes).not.toHaveBeenCalled();
  expect(await cmdFleetMeterDrop(['--json'], readers, now)).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'fleet.meter-drop.v1', incidents: 1, providers: [{ provider: 'codex-personal', verdict: 'flat_with_work', running: 12 }] });
  expect(await cmdFleetMeterDrop([], readers, now)).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toBe('codex-personal: flat_with_work');
});
