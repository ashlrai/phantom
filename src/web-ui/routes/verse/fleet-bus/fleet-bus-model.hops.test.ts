import { expect, it } from 'vitest';
import type { BusEvent, BusHop } from '../fleet/bus-feed-queries.js';
import { busRows, groupEvents, matchEvents } from './fleet-bus-model.js';

it('interleaves hops and events, formats hops, and filters by kind or search', () => {
  const events: BusEvent[] = [
    { at: '2026-01-01T00:00:00Z', kind: 'launch', text: 'started' },
    { at: '2026-01-03T00:00:00Z', kind: 'inbox', text: 'hello' },
  ];
  const hop: BusHop & { at: string } = { id: 'hop-1', from: 'leader-opus', to: 'worker-terra', inputTokens: 1200, outputTokens: 34, at: '2026-01-02T00:00:00Z' };
  const rows = busRows(events, [hop]);
  expect(rows.map(row => row.kind)).toEqual(['inbox', 'hop', 'launch']);
  expect(rows[1]).toEqual({ at: hop.at, kind: 'hop', text: 'leader-opus → worker-terra · 1.2k in / 34 out', hopId: hop.id });
  expect(groupEvents(rows, 'hop')).toEqual([rows[1]]);
  expect(matchEvents(rows, 'HOP')).toEqual([rows[1]]);
  expect(busRows(events, [hop], 2)).toEqual(rows.slice(0, 2));
});

it('keeps rows beyond the shared timeline limit and puts unknown times last', () => {
  const events: BusEvent[] = Array.from({ length: 45 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), kind: 'orch', text: String(i) }));
  const hop: BusHop = { id: 'h', from: 'a', to: 'b', inputTokens: null, outputTokens: 0 };
  expect(busRows(events, [hop])).toHaveLength(46);
  expect(busRows(events, [hop]).at(-1)).toMatchObject({ kind: 'hop', at: '', text: 'a → b · ? in / 0 out' });
  expect(busRows(events, [hop], 60, '2026-01-01T00:00:30.500Z')[14].kind).toBe('hop');
});
