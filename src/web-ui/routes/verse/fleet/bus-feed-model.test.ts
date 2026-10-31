import { describe, expect, it } from 'vitest';
import { busTimeline, describeHop, eventTone, relativeAt } from './bus-feed-model.js';
import { narrowBusFeed, type BusFeedData } from './bus-feed-queries.js';

const hop = { id: 'h', from: 'leader', to: 'worker', inputTokens: 1200, outputTokens: 340 };
const data: BusFeedData = { v: 1, hops: [hop], hopsDropped: 0, lastHopAt: '2026-10-31T12:00:00Z', events: [], sources: { hops: 'healthy', events: 'healthy' } };
describe('agent bus model', () => {
  it('merges newest first, preserves hop order and caps at 40 without mutating input', () => {
    const value = { ...data, hops: [hop, { ...hop, id: 'new' }], events: Array.from({ length: 45 }, (_, i) => ({ at: new Date(Date.parse(data.lastHopAt!) - 1000 + i * 1000).toISOString(), kind: 'orch' as const, text: String(i) })) };
    const rows = busTimeline(value);
    expect(rows).toHaveLength(40);
    expect(rows[0].text).toBe('44');
    expect(value.events[0].text).toBe('0');
    const merged = busTimeline({ ...value, events: value.events.slice(0, 3) });
    expect(merged.map(row => row.key)).toEqual(['event:2', 'event:1', 'hop:1:new', 'hop:0:h', 'event:0']);
  });
  it('formats counts and nulls', () => {
    expect(describeHop(hop)).toBe('leader → worker · 1.2k in / 340 out');
    expect(describeHop({ ...hop, inputTokens: null, outputTokens: null })).toBe('leader → worker · ? in / ? out');
    expect(describeHop({ ...hop, inputTokens: 0, outputTokens: 1000 })).toContain('0 in / 1k out');
  });
  it('maps every event tone', () => {
    expect(['incident', 'lane-hold', 'inbox', 'orch', 'launch', 'published', 'other'].map(kind => eventTone(kind as Parameters<typeof eventTone>[0])))
      .toEqual(['danger', 'warning', 'info', 'running', 'neutral', 'neutral', 'neutral']);
  });
  it('formats elapsed time and handles missing or future times', () => {
    const now = Date.parse(data.lastHopAt!);
    expect(relativeAt(new Date(now - 120_000).toISOString(), now)).toBe('2 m ago');
    expect(relativeAt(null, now)).toBe('unknown');
    expect(relativeAt(new Date(now + 1000).toISOString(), now)).toBe('0 s ago');
  });
  it('rejects malformed responses instead of manufacturing an empty bus', () => {
    expect(narrowBusFeed(data)).toEqual(data);
    for (const bad of [{}, { ...data, v: 2 }, { ...data, sources: { hops: 'broken', events: 'healthy' } }, { ...data, hops: [{ ...hop, inputTokens: -1 }] }, { ...data, events: [{ at: 'bad', kind: 'orch', text: 'x' }] }]) expect(narrowBusFeed(bad)).toBeNull();
  });
});
