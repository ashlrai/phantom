import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdUsageHistory } from '../src/cli/usage-history.js';
import { runResourceLiveTick } from '../src/core/usage/resource-live/engine.js';
import { projectLaneHistory, readLaneHistory } from '../src/core/usage/resource-live/history.js';
import { appendResourceHistory, parseResourceHistory, readResourceHistoryFile, resourceHistoryPath, toReading } from '../src/core/usage/resource-live/store.js';
import { RESOURCE_HISTORY_SCHEMA, RESOURCE_LIVE_ALLOWANCES, type ResourceHistoryPoint } from '../src/core/usage/resource-live/types.js';
import { presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import { projectWorldModel } from '../src/core/world/project.js';
import type { ResourceLiveSources, ResourceLiveSource } from '../src/core/usage/resource-live/source-types.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z'), MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const reset = iso(NOW + 3600_000);
const point = (ago: number, used = 40): ResourceHistoryPoint => ({ observed_at: iso(NOW - ago * MIN), used,
  left: 100 - used, limit: 100, unit: 'acu', reset_at: reset, source: 'test', source_tier: 'official', confidence: 'high' });
const file = (points: unknown[]) => ({ schema: RESOURCE_HISTORY_SCHEMA, allowances: { devin: points } });
const project = (points: ResourceHistoryPoint[]) => projectLaneHistory(file(points), NOW)['devin']!;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lane-history-')); dirs.push(d); return d; };
const sources = (devin: ResourceLiveSource[] = []) => Object.fromEntries(
  RESOURCE_LIVE_ALLOWANCES.map(a => [a.id, a.id === 'devin' ? devin : []])) as ResourceLiveSources;
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); });

it('keeps verbatim measurements, skips unverified, duplicate, old and sub-five-minute observations', () => {
  const a = RESOURCE_LIVE_ALLOWANCES.find(a => a.id === 'devin')!;
  const reading = (ago: number) => toReading(a, { ...point(ago), id: 'devin', verified: true });
  const first = appendResourceHistory(null, [reading(10)], NOW);
  expect(first.allowances.devin).toEqual([point(10)]);
  for (const ago of [10, 11, 6]) expect(appendResourceHistory(first, [reading(ago)], NOW)).toEqual(first);
  expect(appendResourceHistory(first, [{ ...reading(0), verified: false }], NOW)).toEqual(first);
  expect(appendResourceHistory(first, [reading(5)], NOW).allowances.devin).toHaveLength(2);
  expect(appendResourceHistory(null, [reading(8 * 24 * 60)], NOW).allowances).toEqual({});
});

it('drops malformed and expired rows and bounds each ring independently of the short sidecar history', () => {
  const parsed = parseResourceHistory(file([null, {}, { ...point(0), source: null }, point(8 * 24 * 60), point(0)]), NOW);
  expect(parsed.allowances.devin).toEqual([point(0)]);
  expect(parseResourceHistory({ schema: 'wrong' }, NOW).allowances).toEqual({});
  const points = Array.from({ length: 2100 }, (_, i) => point(2099 - i));
  expect(parseResourceHistory(file(points), NOW).allowances.devin).toHaveLength(2016);
});

it('picks the last real point per hour, marks raw gaps and computes measured exhaustion', () => {
  const points = [point(80, 10), point(60, 20), point(45, 30), point(0, 40)];
  const h = project(points);
  expect(h.points.map(p => p.observedAt)).toEqual([points[0]!.observed_at, points[2]!.observed_at, points[3]!.observed_at]);
  expect(h.points.at(-1)?.gapBefore).toBe(true);
  expect(h.burn).toBeNull();
  const measured = project([point(30, 20), point(15, 30), point(0, 40)]);
  expect(measured.burn).toMatchObject({ perHour: 40, from: iso(NOW - 30 * MIN), to: iso(NOW) });
  expect(measured.exhaustAt).toBe(iso(NOW + 1.5 * 3600_000));
  expect(measured.resetAt).toBe(reset);
});

it('does not measure burn with one point, short spans, reset transitions, decreases or gaps', () => {
  for (const points of [[point(0)], [point(5), point(0)],
    [{ ...point(20), reset_at: null }, point(0)], [point(20, 80), point(0)], [point(40), point(0)]]) {
    expect(project(points).burn).toBeNull(); expect(project(points).exhaustAt).toBeNull();
  }
  expect(projectLaneHistory(null, NOW)).toEqual({});
});

it('preserves a raw gap before 10:40 when the hourly bucket selects 10:50', () => {
  const h = project([point(125, 10), point(80, 20), point(70, 30)]);
  expect(h.points.map(p => p.observedAt)).toEqual(['2026-11-16T09:55:00.000Z', '2026-11-16T10:50:00.000Z']);
  expect(h.points.map(p => p.gapBefore)).toEqual([false, true]);
});

it('persists engine ticks privately and unverified polls add no readings', async () => {
  const runsDir = tmp();
  await runResourceLiveTick({ runsDir, nowMs: NOW, force: true, sources: sources([{ tier: 'official',
    read: async () => ({ used: 40, limit: 100, unit: 'acu', source: 'test', observed_at: iso(NOW), reset_at: reset }) }]) });
  const stored = await readResourceHistoryFile(runsDir);
  expect(parseResourceHistory(stored, NOW).allowances.devin).toEqual([point(0)]);
  expect(statSync(resourceHistoryPath(runsDir)).mode & 0o777).toBe(0o600);
  await runResourceLiveTick({ runsDir, nowMs: NOW + 10 * MIN, force: true, sources: sources() });
  expect(await readResourceHistoryFile(runsDir)).toEqual(stored);
});

it('reads missing, symlinked, malformed and oversized files as empty', async () => {
  const dir = tmp(); mkdirSync(join(dir, 'state'));
  expect(await readResourceHistoryFile(dir)).toBeNull();
  const target = join(dir, 'target'); writeFileSync(target, '{}');
  symlinkSync(target, resourceHistoryPath(dir)); expect(await readResourceHistoryFile(dir)).toBeNull();
  rmSync(resourceHistoryPath(dir)); writeFileSync(resourceHistoryPath(dir), '{');
  expect(await readResourceHistoryFile(dir)).toBeNull();
  writeFileSync(resourceHistoryPath(dir), ' '.repeat(8 * 1024 * 1024 + 1));
  expect(await readResourceHistoryFile(dir)).toBeNull();
});

it('carries projected history through world lanes, leaving Fable alone', () => {
  const laneHistory = projectLaneHistory(file([point(20), point(0)]), NOW);
  const model = projectWorldModel({ nowMs: NOW, sensors: presentUsageSensors([{ lane: 'devin', used: 40, limit: 100,
    unit: 'acu', source: 'test', observedAt: iso(NOW), staleAfter: iso(NOW + MIN), resetAt: reset }], NOW), laneHistory,
    roster: null, claims: null, busReadable: null, queue: null, ci: null, updatePhase: null,
    bottlenecks: null, bottlenecksObservedAt: null, stepsRemaining: null, stepsObservedAt: null, outcomes: null });
  expect(model.sensors.lanes.find(l => l.lane === 'devin')?.history).toEqual(laneHistory['devin']);
  expect(model.sensors.lanes.find(l => l.lane === 'claude:fable')?.history).toBeUndefined();
});

it('CLI accepts aliases, prints raw points or human lines, and rejects invalid input', async () => {
  const dir = tmp(); mkdirSync(join(dir, 'state'));
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdUsageHistory(['--lane', 'devin', '--runs-dir', dir, '--json'])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).points).toEqual([]);
  const p = { ...point(0), observed_at: new Date().toISOString() };
  writeFileSync(resourceHistoryPath(dir), JSON.stringify(file([p])));
  expect(await cmdUsageHistory(['--lane', 'devin', '--runs-dir', dir])).toBe(0);
  expect(out.mock.calls.at(-1)?.[0]).toContain('used=40/100');
  expect((await readLaneHistory('claude', dir))?.id).toBe('claude-weekly');
  for (const args of [[], ['--lane', 'wat'], ['--lane', 'devin', '--runs-dir', 'relative'], ['--bad']])
    expect(await cmdUsageHistory(args)).toBe(2);
  expect(err).toHaveBeenCalled();
});
