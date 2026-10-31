import { expect, it } from 'vitest';
import type { BusEvent } from '../fleet/bus-feed-queries.js';
import { busFilterLabel, matchEvents } from './fleet-bus-model.js';

it('matches text and kind case-insensitively and preserves order', () => {
  const events: BusEvent[] = [
    { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'RQ-PHX-HOSTLOAD31 in lane alpha' },
    { at: '2026-01-02T00:00:00Z', kind: 'inbox', text: 'Mason says hello' },
  ];
  expect(matchEvents(events, 'hostload31')).toEqual([events[0]]);
  expect(matchEvents(events, 'LANE ALPHA')).toEqual([events[0]]);
  expect(matchEvents(events, 'INBOX')).toEqual([events[1]]);
  expect(matchEvents(events, 'missing')).toEqual([]);
  expect(matchEvents(events, '')).toEqual(events);
  expect(busFilterLabel(4, 50)).toBe('4 of 50 events');
  expect(busFilterLabel(5, 5)).toBe('');
  expect(busFilterLabel(0, 5)).toBe('0 of 5 events');
});
