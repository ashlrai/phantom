import { expect, it } from 'vitest';
import type { FleetLiveMap, LiveMapEdge } from '../../../../core/fleet/live-map.js';
import { edgeOpacity } from './map-model.js';

const map = { windowMinutes: 15 } as FleetLiveMap;
const now = Date.parse('2026-11-18T00:15:00Z');
const line = (lastMessageAt: string | null) => ({ id: 'a->b', kind: 'messaged-in-last-15-min', from: 'a', to: 'b', messages: 1, lastMessageAt, pulse: false }) as LiveMapEdge;

it('fades a message line with age, from solid to a quarter at the window edge', () => {
  expect(edgeOpacity(line('2026-11-18T00:15:00Z'), map, now)).toBe(1);
  expect(edgeOpacity(line('2026-11-18T00:07:30Z'), map, now)).toBe(0.63);
  expect(edgeOpacity(line('2026-11-18T00:00:00Z'), map, now)).toBe(0.25);
  expect(edgeOpacity(line('2026-11-17T23:00:00Z'), map, now)).toBe(0.25);
});
it('keeps a line with no known time at a middle weight', () => {
  expect(edgeOpacity(line(null), map, now)).toBe(0.6);
});
