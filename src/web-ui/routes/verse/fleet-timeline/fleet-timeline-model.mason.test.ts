import { describe, expect, it } from 'vitest';
import type { BusEvent } from '../fleet/bus-feed-queries.js';
import { isMasonItem, masonLane } from './fleet-timeline-model.js';

const from = Date.parse('2026-10-31T12:00:00Z');
const to = Date.parse('2026-10-31T13:00:00Z');
const event = (at: string, text: string, kind: BusEvent['kind'] = 'inbox'): BusEvent => ({ at, kind, text });

describe('masonLane', () => {
  it('includes only inbox events within the inclusive window, oldest first, as instants', () => {
    const events = [
      event('2026-10-31T13:00:00Z', 'INBOX Mason, second order'),
      event('2026-10-31T11:59:59Z', 'INBOX too early'),
      event('2026-10-31T12:20:00Z', 'other kind', 'orch'),
      event('2026-10-31T14:00:00Z', 'too late'),
      event('invalid', 'bad date'),
      event('2026-10-31T12:00:00Z', ' INBOX: Mason, first order  '),
    ];
    const lane = masonLane(events, from, to)!;
    expect(lane).toMatchObject({ id: 'mason', label: 'Mason' });
    expect(lane.items).toEqual([
      { id: 'inbox:2026-10-31T12:00:00Z', label: 'first order', detail: 'first order', start: from, end: from, status: 'interjection' },
      { id: 'inbox:2026-10-31T13:00:00Z', label: 'second order', detail: 'second order', start: to, end: to, status: 'interjection' },
    ]);
    expect(isMasonItem(lane.items[0]!)).toBe(true);
    expect(isMasonItem({ ...lane.items[0]!, id: 'worker-job' })).toBe(false);
  });

  it('trims prefixes and whitespace before limiting labels to 80 characters', () => {
    const lane = masonLane([event('2026-10-31T12:30:00Z', `INBOX Mason, ${'x'.repeat(100)} `)], from, to)!;
    expect(lane.items[0]!.label).toBe('x'.repeat(80));
  });

  it('returns null for no inbox events in range', () => {
    expect(masonLane([], from, to)).toBeNull();
    expect(masonLane([event('2026-10-31T11:00:00Z', 'old'), event('2026-10-31T12:10:00Z', 'other', 'orch')], from, to)).toBeNull();
  });
});
