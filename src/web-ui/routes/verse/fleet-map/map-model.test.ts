import { afterEach, expect, it } from 'vitest';
import type { FleetLiveMap, LiveMapEdge } from '../../../../core/fleet/live-map.js';
import { edgeOpacity, emptyMap, mapHeadline, messageCurve, messagePairs, NODE_H, pulsing, readMapFilter, remoteGroup, saveMapFilter, type PlacedNode } from './map-model.js';
import { orgBoxLabel } from './org-layout-model.js';

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

const full = (over: Partial<FleetLiveMap>): FleetLiveMap => ({ windowMinutes: 15, pulseSeconds: 60, nodes: [], edges: [],
  counts: { lanes: 0, jobs: 0, computers: 0, resources: 0, messages: 0 },
  sources: { org: 'available', jobs: 'available', computers: 'available', resources: 'unknown', messages: 'available' }, ...over }) as FleetLiveMap;

it('words the headline with plurals and spells out unknown counts', () => {
  const counts = { lanes: 1, jobs: 1, computers: 3, resources: 0, messages: 5 };
  expect(mapHeadline(full({ counts }))).toBe('1 job · 3 computers · 5 messages in 15 minutes');
  expect(mapHeadline(full({ counts: { ...counts, messages: 1 } }))).toBe('1 job · 3 computers · 1 message in 15 minutes');
  expect(mapHeadline(full({ counts: { ...counts, jobs: 0, messages: null }, sources: { jobs: 'unknown', computers: 'unknown' } as never })))
    .toBe('jobs unknown · computers unknown · messages unknown');
});

it('calls a map empty when only the leader is on it', () => {
  const n = (kind: string) => ({ id: kind, kind }) as never;
  expect(emptyMap(full({ nodes: [n('leader')] }))).toBe(true);
  expect(emptyMap(full({ nodes: [n('leader'), n('lane')] }))).toBe(false);
});

it('pulses inside the window either side of now, never under reduced motion, and follows the server flag without a time', () => {
  const m = full({});
  expect(pulsing(line('2026-11-18T00:14:30Z'), m, now)).toBe(true);
  expect(pulsing(line('2026-11-18T00:10:00Z'), m, now)).toBe(false);
  expect(pulsing(line('2026-11-18T00:15:30Z'), m, now)).toBe(true);
  expect(pulsing(line('2026-11-18T00:14:30Z'), m, now, true)).toBe(false);
  expect(pulsing({ ...line(null), pulse: true }, m, now)).toBe(true);
  expect(pulsing({ ...line(null), pulse: true }, m, now, true)).toBe(false);
});

it('merges both directions of a pair into one count, unknown if either is unknown, and skips other kinds and self-lines', () => {
  const e = (from: string, to: string, messages: number | null, kind = 'messaged-in-last-15-min') => ({ ...line(null), id: `${from}>${to}`, kind, from, to, messages }) as LiveMapEdge;
  const pairs = messagePairs(full({ edges: [e('a', 'b', 2), e('b', 'a', 3), e('a', 'c', 1), e('c', 'a', null), e('a', 'a', 9), e('a', 'd', 4, 'reports-to')] }));
  expect(pairs.map(pair => pair.count)).toEqual([5, null]);
});

it('bows a same-row curve above the nodes and a cross-row curve sideways, with the true midpoint', () => {
  const row = messageCurve({ x: 0, y: 100 }, { x: 200, y: 100 });
  expect(row.d).toBe(`M0,100 Q100,${100 - NODE_H - 36} 200,100`);
  expect(row.mid).toEqual({ x: 100, y: 100 - (NODE_H + 36) / 2 });
  expect(messageCurve({ x: 0, y: 0 }, { x: 100, y: 200 }).d).toBe('M0,0 Q90,60 100,200');
  expect(messageCurve({ x: 100, y: 0 }, { x: 0, y: 200 }).d).toBe('M100,0 Q10,60 0,200');
});

it('boxes only the remote Macs and counts the offline and unknown ones', () => {
  const c = (id: string, x: number, status: string, remote?: boolean) => ({ id, kind: 'computer', x, y: 200, status, remote }) as PlacedNode;
  expect(remoteGroup([c('a', 100, 'ready')])).toEqual([]);
  const [box] = remoteGroup([c('a', 100, 'ready'), c('b', 300, 'offline', true), c('c', 500, 'unknown', true), c('d', 700, 'ready', true)]);
  expect(box.label).toBe('Other Macs: 3, 1 offline, 1 unknown');
  expect(box.x).toBe(300 - 70 - 8);
  expect(box.x + box.width).toBe(700 + 70 + 8);
});

it('labels an org box with its running count and any unknown ones', () => {
  expect(orgBoxLabel({ label: 'claude', counts: { running: 2, unknown: 0 } as never })).toBe('claude: 2 running');
  expect(orgBoxLabel({ label: 'grok', counts: { running: 0, unknown: 3 } as never })).toBe('grok: 0 running, 3 unknown');
});

afterEach(() => sessionStorage.clear());
it('remembers the picked filters, ignores a bad state or junk, and survives blocked storage', () => {
  expect(readMapFilter()).toEqual({});
  saveMapFilter({ lane: 'claude', repo: null, state: 'running' });
  expect(readMapFilter()).toMatchObject({ lane: 'claude', state: 'running' });
  sessionStorage.setItem('phantom.fleet-map.filter', JSON.stringify({ lane: 'x', state: 'bogus' }));
  expect(readMapFilter().state).toBeNull();
  sessionStorage.setItem('phantom.fleet-map.filter', '{nope');
  expect(readMapFilter()).toEqual({});
});
