import { describe, expect, it } from 'vitest';
import {
  appendLaneLog,
  LANE_LOG_MAX_EVENTS,
  LANE_LOG_STORAGE_KEY,
  laneEventItems,
  laneEventText,
  laneTransitions,
  loadLaneLog,
  type LaneEvent,
  type LaneHoldState,
} from './thread-lane-events.js';

const NOW = Date.UTC(2026, 10, 7, 20, 0);

const row = (lane: string, held: boolean, over: Partial<LaneHoldState> = {}): LaneHoldState =>
  ({ lane, held, heldReason: null, heldUntil: null, lastChange: null, ...over });

const event = (lane: string, kind: LaneEvent['kind'], atMs: number): LaneEvent =>
  ({ lane, kind, reason: kind === 'held' ? 'usage_limit' : null, until: null, atMs });

function memStorage(seed?: string) {
  const map = new Map<string, string>(seed === undefined ? [] : [[LANE_LOG_STORAGE_KEY, seed]]);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

describe('laneTransitions', () => {
  it('emits a held event with reason, until and the row’s change time', () => {
    const prev = [row('codex-personal', false), row('claude', true)];
    const next = [
      row('codex-personal', true, { heldReason: 'usage_limit', heldUntil: '2026-11-07T20:16:00.000Z', lastChange: '2026-11-07T19:58:00.000Z' }),
      row('claude', true),
    ];
    expect(laneTransitions(prev, next, NOW)).toEqual([
      { lane: 'codex-personal', kind: 'held', reason: 'usage_limit', until: '2026-11-07T20:16:00.000Z', atMs: Date.parse('2026-11-07T19:58:00.000Z') },
    ]);
  });

  it('emits a resumed event when the hold lifts, stamped at observation when lastChange is missing', () => {
    const prev = [row('codex-personal', true, { heldReason: 'usage_limit', heldUntil: '2026-11-07T20:16:00.000Z' })];
    const next = [row('codex-personal', false)];
    expect(laneTransitions(prev, next, NOW)).toEqual([
      { lane: 'codex-personal', kind: 'resumed', reason: null, until: null, atMs: NOW },
    ]);
  });

  it('stays quiet when nothing flipped, even if the held reason changed', () => {
    const prev = [row('claude', true, { heldReason: 'manual' }), row('devin', false)];
    const next = [row('claude', true, { heldReason: 'usage_limit' }), row('devin', false)];
    expect(laneTransitions(prev, next, NOW)).toEqual([]);
  });

  it('emits nothing for a lane that appears already held or one that disappears', () => {
    const prev = [row('devin', false), row('gone', true)];
    const next = [row('devin', false), row('zai', true, { heldReason: 'usage_limit' })];
    expect(laneTransitions(prev, next, NOW)).toEqual([]);
  });

  it('records a baseline on the first load and emits nothing', () => {
    expect(laneTransitions(null, [row('codex-personal', true, { heldReason: 'usage_limit' })], NOW)).toEqual([]);
    expect(laneTransitions(undefined, [row('devin', false)], NOW)).toEqual([]);
  });
});

describe('loadLaneLog / appendLaneLog', () => {
  it('round-trips the snapshot and events, and appends across calls', () => {
    const storage = memStorage();
    appendLaneLog(storage, [row('devin', false)], []);
    const next = appendLaneLog(storage, [row('devin', true, { heldReason: 'usage_limit' })], [event('devin', 'held', NOW)]);
    expect(next.events).toHaveLength(1);
    const loaded = loadLaneLog(storage);
    expect(loaded.snapshot).toEqual([{ lane: 'devin', held: true, heldReason: 'usage_limit', heldUntil: null, lastChange: null }]);
    expect(loaded.events).toEqual([event('devin', 'held', NOW)]);
  });

  it('keeps only the newest 100 events', () => {
    const storage = memStorage();
    appendLaneLog(storage, [row('devin', false)], []);
    appendLaneLog(storage, [row('devin', false)], Array.from({ length: LANE_LOG_MAX_EVENTS + 5 }, (_, i) => event('devin', 'held', i)));
    const loaded = loadLaneLog(storage);
    expect(loaded.events).toHaveLength(LANE_LOG_MAX_EVENTS);
    expect(loaded.events[0]!.atMs).toBe(5);
  });

  it('yields an empty log on missing, corrupt or wrongly shaped storage', () => {
    const empty = { snapshot: null, events: [] };
    expect(loadLaneLog(memStorage())).toEqual(empty);
    expect(loadLaneLog(memStorage('not json {'))).toEqual(empty);
    expect(loadLaneLog(memStorage('"a string"'))).toEqual(empty);
    expect(loadLaneLog(memStorage('{"snapshot":"bogus","events":[{"bad":1}]}'))).toEqual(empty);
    expect(loadLaneLog(null)).toEqual(empty);
    expect(loadLaneLog(undefined)).toEqual(empty);
  });

  it('never throws when storage denies writes', () => {
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadLaneLog(denied)).toEqual({ snapshot: null, events: [] });
    const log = appendLaneLog(denied, [row('devin', true)], [event('devin', 'held', NOW)]);
    expect(log.events).toHaveLength(1);
  });
});

describe('laneEventItems', () => {
  it('renders the held line with the ET until and a stable id', () => {
    const [line] = laneEventItems([{ lane: 'codex-personal', kind: 'held', reason: 'usage_limit', until: '2026-11-07T20:16:00.000Z', atMs: NOW }]);
    expect(line).toMatchObject({ at: NOW, who: 'leader', source: 'system', ack: null });
    expect(line!.id).toBe(`lane-codex-personal-held-${NOW}`);
    expect(line!.text).toBe('codex-personal held: usage_limit, until Nov 7 15:16');
  });

  it('renders the resumed line, and a hold without reason or until', () => {
    expect(laneEventText(event('codex-personal', 'resumed', NOW))).toBe('codex-personal is running again');
    expect(laneEventText({ lane: 'claude', kind: 'held', reason: null, until: null, atMs: NOW })).toBe('claude held');
    expect(laneEventText({ lane: 'claude', kind: 'held', reason: null, until: 'not a date', atMs: NOW })).toBe('claude held');
  });
});
