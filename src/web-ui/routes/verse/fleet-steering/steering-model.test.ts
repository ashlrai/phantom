import { describe, expect, it } from 'vitest';
import { buildSteering, naiveClock, summarizeReaction } from './steering-model.js';

const entry = (at: string, text: string, source = 'Phantom desktop') => ({ at, source, text });
const event = (at: string, kind: string, text: string) => ({ at, kind, text });

describe('naiveClock', () => {
  it('parses inbox and event formats and garbage', () => {
    expect(naiveClock('2026-10-31 00:13')).not.toBeNull();
    expect(naiveClock('2026-10-31T00:13:45Z')).not.toBeNull();
    expect(naiveClock('2026-10-31T00:13:45')).not.toBeNull();
    for (const bad of [null, undefined, 42, {}, '', 'garbage', '## a heading',
      '2026-10-31', '2026-10-31T', '2026-13-01 00:00', '2026-02-30 00:00',
      '2026-10-31 24:00', '2026-10-31 00:60', '2026-10-31T00:00:60Z']) {
      expect(naiveClock(bad), String(bad)).toBeNull();
    }
    // Leap days honoured proleptically.
    expect(naiveClock('2024-02-29 12:00')).not.toBeNull();
    expect(naiveClock('2026-02-29 12:00')).toBeNull();
  });

  it('counts seconds as a fraction of a minute', () => {
    expect(naiveClock('2026-10-31T00:14:30Z')! - naiveClock('2026-10-31 00:13')!).toBe(1.5);
    expect(naiveClock('2026-11-01 00:00')! - naiveClock('2026-10-31 23:59')!).toBe(1);
  });

  it('treats the event Z as a label: equal digits compare equal', () => {
    expect(naiveClock('2026-10-31T00:13:00Z')).toBe(naiveClock('2026-10-31 00:13'));
  });
});

describe('buildSteering', () => {
  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 'text', 7, [], { inbox: 'x', events: 5 },
      { inbox: [{ at: 1 }], events: [{ at: 'x' }] }, { inbox: [{}], events: [null] }]) {
      expect(() => buildSteering(bad)).not.toThrow();
      expect(buildSteering(bad)).toEqual([]);
    }
    expect(buildSteering({ inbox: [entry('2026-10-31 00:13', 'go')], events: 'nope' })[0].events).toEqual([]);
  });

  it('windows events between an order and the next newer order, newest first', () => {
    // 3 orders (fed newest-last, like the inbox file), 8 events.
    const snapshot = {
      inbox: [entry('2026-10-31 00:01', 'first order'), entry('2026-10-31 00:10', 'second order'), entry('2026-10-31 00:13', 'third order')],
      events: [
        event('2026-10-30T23:59:00Z', 'LAUNCH', 'before any order'),
        event('2026-10-31T00:01:30Z', 'LEADER', 'saw first order'),
        event('2026-10-31T00:05:00Z', 'LAUNCH', 'launch a'),
        event('2026-10-31T00:09:59Z', 'INCIDENT', 'a fire'),
        event('2026-10-31T00:10:00Z', 'LANE_HOLD', 'held'),
        event('2026-10-31T00:12:00Z', 'PUBLISHED', 'pr out'),
        event('2026-10-31T00:20:00Z', 'OPUS-LEADER', 'opus pass'),
        event('2026-10-31T01:00:00Z', 'LAUNCH', 'later launch'),
      ],
    };
    const [third, second, first] = buildSteering(snapshot);
    expect(third.text).toBe('third order');
    // The newest order's window is open-ended.
    expect(third.after).toEqual({ passes: 1, launches: 1, publishes: 0, holds: 0, incidents: 0, other: 0 });
    expect(third.events.map((e) => e.kind)).toEqual(['OPUS-LEADER', 'LAUNCH']);
    expect(third.firstReactionMinutes).toBe(7);
    expect(second.after).toEqual({ passes: 0, launches: 0, publishes: 1, holds: 1, incidents: 0, other: 0 });
    expect(second.events.map((e) => e.kind)).toEqual(['LANE_HOLD', 'PUBLISHED']);
    expect(second.firstReactionMinutes).toBeNull();
    // The event at the window's very second counts toward the order.
    expect(first.after).toEqual({ passes: 1, launches: 1, publishes: 0, holds: 0, incidents: 1, other: 0 });
    expect(first.events.map((e) => e.kind)).toEqual(['LEADER', 'LAUNCH', 'INCIDENT']);
    expect(first.firstReactionMinutes).toBeCloseTo(0.5);
    // Events before the oldest order are attributed to nothing.
    expect(first.events.some((e) => e.text === 'before any order')).toBe(false);
  });

  it('ignores unparsable stamps on both sides', () => {
    // The unparseable stamp sinks to the end, after the parseable orders.
    const [real, weird] = buildSteering({
      inbox: [entry('## mangled heading', 'mangled'), entry('2026-10-31 00:13', 'real order')],
      events: [event('not a time', 'LAUNCH', 'no clock'), event('2026-10-31T00:14:00Z', 'LEADER', 'pass')],
    });
    expect(weird.text).toBe('mangled');
    expect(weird.after).toEqual({ passes: 0, launches: 0, publishes: 0, holds: 0, incidents: 0, other: 0 });
    expect(weird.firstReactionMinutes).toBeNull();
    expect(weird.events).toEqual([]);
    expect(real.after.passes).toBe(1);
    expect(real.events.map((e) => e.text)).toEqual(['pass']);
  });

  it('keeps an event at the order minute inside the order window', () => {
    const [order] = buildSteering({
      inbox: [entry('2026-10-31 00:13', 'go')],
      events: [event('2026-10-31T00:13:00Z', 'INBOX', 'receipt'), event('2026-10-31T00:12:59Z', 'LAUNCH', 'too early')],
    });
    expect(order.events.map((e) => e.text)).toEqual(['receipt']);
    expect(order.after.other).toBe(1);
  });
});

describe('summarizeReaction', () => {
  it('joins the nonzero counts and names the quiet window', () => {
    const [order] = buildSteering({
      inbox: [entry('2026-10-31 00:13', 'go')],
      events: [event('2026-10-31T00:14:00Z', 'LEADER', 'a'), event('2026-10-31T00:15:00Z', 'LEADER', 'b'),
        event('2026-10-31T00:16:00Z', 'LAUNCH', 'c'), event('2026-10-31T00:17:00Z', 'PUBLISHED', 'd')],
    });
    expect(summarizeReaction(order)).toBe('2 passes, 1 launch, 1 publish');
    const [quiet] = buildSteering({ inbox: [entry('2026-10-31 00:13', 'go')], events: [] });
    expect(summarizeReaction(quiet)).toBe('No leader pass yet');
  });
});
