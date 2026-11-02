import { expect, it } from 'vitest';
import type { BusEvent, BusHop } from '../fleet/bus-feed-queries.js';
import { groupEvents, isInterjection, summarizeHops } from './fleet-bus-model.js';

it('summarizes distinct agents and known token totals safely', () => {
  const hops: BusHop[] = [
    { id: '1', from: 'a', to: 'b', inputTokens: 1000, outputTokens: null },
    { id: '2', from: 'b', to: 'c', inputTokens: null, outputTokens: 20 },
    { id: '3', from: 'a', to: 'c', inputTokens: 50, outputTokens: 0 },
  ];
  expect(summarizeHops(hops)).toEqual({ hops: 3, inputTokens: 1050, outputTokens: 20, agents: 3 });
  expect(summarizeHops([])).toEqual({ hops: 0, inputTokens: null, outputTokens: null, agents: 0 });
  expect(summarizeHops([{ ...hops[0], inputTokens: Number.MAX_SAFE_INTEGER }, hops[2]]).inputTokens).toBeNull();
});

it('filters and orders events newest first while preserving ties and identifying interjections', () => {
  const events: BusEvent[] = [
    { at: '2026-01-01T00:00:00Z', kind: 'inbox', text: 'old' },
    { at: '2026-01-02T00:00:00Z', kind: 'launch', text: 'first tie' },
    { at: '2026-01-02T00:00:00Z', kind: 'inbox', text: 'second tie' },
  ];
  expect(groupEvents(events, null).map(e => e.text)).toEqual(['first tie', 'second tie', 'old']);
  expect(groupEvents(events, 'inbox').map(e => e.text)).toEqual(['second tie', 'old']);
  expect(isInterjection(events[0])).toBe(true);
  expect(isInterjection(events[1])).toBe(false);
  expect(events[0].text).toBe('old');
});
