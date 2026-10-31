import { expect, it } from 'vitest';
import { headerText, laneFill, laneNote, narrowRunsLanes, sortLanes, type RunsLane } from './runs-lanes-model.js';

const lane: RunsLane = { lane: 'codex-personal', running: 24, target: 24, queued: 2, held: false, heldReason: null, tokensLastHour: 12000, merged24h: 3, mergeRate24h: 0.125 };
const data = { v: 1, generatedAt: '2026-10-31T12:00:40Z', lastTick: '2026-10-31T12:00:00Z', paused: false, switches: [], sources: { runsDir: 'healthy' }, lanes: [lane] };
it('narrows only the lanes projection and preserves nullable metrics', () => {
  expect(narrowRunsLanes({ ...data, workers: 'ignored' })).toEqual({ generatedAt: data.generatedAt, lastTick: data.lastTick, paused: false, switches: [], sources: data.sources, lanes: [lane] });
  expect(narrowRunsLanes({ ...data, lastTick: null, paused: null, lanes: [{ ...lane, tokensLastHour: null, merged24h: null, mergeRate24h: null }] })).not.toBeNull();
});
it('rejects malformed envelope fields', () => {
  for (const invalid of [null, [], {}, { ...data, v: 2 }, { ...data, generatedAt: 2 }, { ...data, lastTick: undefined }, { ...data, paused: 'false' }, { ...data, switches: [1] }, { ...data, sources: { runsDir: 'ok' } }, { ...data, sources: null }, { ...data, lanes: {} }]) expect(narrowRunsLanes(invalid)).toBeNull();
});
it('rejects malformed lane fields rather than silently dropping a row', () => {
  for (const patch of [{ lane: '' }, { lane: 2 }, { running: -1 }, { target: 1.5 }, { queued: NaN }, { held: 1 }, { heldReason: false }, { tokensLastHour: Infinity }, { merged24h: undefined }, { mergeRate24h: -1 }, { mergeRate24h: '1' }]) expect(narrowRunsLanes({ ...data, lanes: [lane, { ...lane, ...patch }] })).toBeNull();
});
it('sorts by running then lane without mutating the input', () => {
  const lanes = [{ ...lane, lane: 'z', running: 5 }, { ...lane, lane: 'b' }, { ...lane, lane: 'a' }];
  expect(sortLanes(lanes).map(l => l.lane)).toEqual(['a', 'b', 'z']);
  expect(lanes[0]!.lane).toBe('z');
});
it('formats fill and prioritizes held reasons over queued notes', () => {
  expect(laneFill(lane)).toBe('24 / 24');
  expect(laneNote(lane)).toBe('queued 2 · drains in ~13 min');
  expect(laneNote({ ...lane, held: true, heldReason: 'quota' })).toBe('held: quota');
  expect(laneNote({ ...lane, held: true })).toBe('held: reason unknown');
  expect(laneNote({ ...lane, queued: 0 })).toBe('saturated · 0 queued, 0 free');
});
it('prioritizes pause then switches then tick age and tone', () => {
  const runs = narrowRunsLanes(data)!;
  const now = Date.parse(data.generatedAt);
  expect(headerText(runs, now)).toBe('tick 40s ago · fresh');
  expect(headerText({ ...runs, paused: true, switches: ['HOLD'] }, now)).toBe('dispatcher paused');
  expect(headerText({ ...runs, switches: ['HOLD'] }, now)).toBe('switches on: HOLD');
  expect(headerText(runs, now + 300_000)).toContain('· late');
  expect(headerText(runs, now + 1200_000)).toContain('· stale');
  expect(headerText({ ...runs, lastTick: null }, now)).toBe('tick unknown · unknown');
});
