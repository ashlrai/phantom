import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FleetLiveMap, LiveMapEdge, LiveMapNode } from '../../../../core/fleet/live-map.js';
import {
  emptyMap, MAP_FILTER_KEY, mapHeadline, messageCurve, messagePairs, NODE_H, NODE_W,
  pulsing, readMapFilter, remoteGroup, saveMapFilter, type PlacedNode,
} from './map-model.js';
import { orgBoxLabel } from './org-layout-model.js';

const now = Date.parse('2026-11-18T00:15:00Z');
const full = (over: Partial<FleetLiveMap> = {}): FleetLiveMap => ({
  schema: 'fleet.live-map.v1', generatedAt: '2026-11-18T00:15:00Z',
  windowMinutes: 15, pulseSeconds: 60, nodes: [], edges: [],
  counts: { lanes: 0, jobs: 0, computers: 0, resources: 0, messages: 0 },
  sources: { org: 'available', jobs: 'available', computers: 'available', resources: 'unknown', messages: 'available' },
  unmappedMessages: null, gaps: [], ...over,
});
const node = (id: string, kind: LiveMapNode['kind']): LiveMapNode => ({
  id, kind, level: kind === 'leader' ? 0 : kind === 'lane' ? 1 : 3,
  label: id, provider: 'unknown', status: 'unknown', detail: 'Synthetic fixture', live: null,
});
const line = (lastMessageAt: string | null, over: Partial<LiveMapEdge> = {}): LiveMapEdge => ({
  id: 'a->b', kind: 'messaged-in-last-15-min', from: 'a', to: 'b',
  messages: 1, lastMessageAt, pulse: false, ...over,
});

let savedFilter: string | null;
beforeEach(() => {
  savedFilter = globalThis.sessionStorage.getItem(MAP_FILTER_KEY);
  globalThis.sessionStorage.removeItem(MAP_FILTER_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedFilter === null) globalThis.sessionStorage.removeItem(MAP_FILTER_KEY);
  else globalThis.sessionStorage.setItem(MAP_FILTER_KEY, savedFilter);
});

it('pluralizes headline counts and spells out unknown sources and messages', () => {
  const map = full({ counts: { lanes: 1, jobs: 1, computers: 3, resources: 0, messages: 5 } });
  expect(mapHeadline(map)).toBe('1 job · 3 computers · 5 messages in 15 minutes');
  expect(mapHeadline({ ...map, counts: { ...map.counts, jobs: 2, computers: 1, messages: 1 } }))
    .toBe('2 jobs · 1 computer · 1 message in 15 minutes');
  expect(mapHeadline(full())).toBe('0 jobs · 0 computers · 0 messages in 15 minutes');
  expect(mapHeadline({
    ...map, counts: { ...map.counts, jobs: 0, messages: null },
    sources: { ...map.sources, jobs: 'unknown', computers: 'unknown' },
  })).toBe('jobs unknown · computers unknown · messages unknown');
});

it('treats no nodes or only the leader as empty, but includes a lane as content', () => {
  expect(emptyMap(full())).toBe(true);
  expect(emptyMap(full({ nodes: [node('leader', 'leader')] }))).toBe(true);
  expect(emptyMap(full({ nodes: [node('leader', 'leader'), node('lane:fixture', 'lane')] }))).toBe(false);
});

it('pulses near now in either direction and honors reduced motion and the untimed server flag', () => {
  const map = full();
  expect(pulsing(line('2026-11-18T00:14:30Z'), map, now)).toBe(true);
  expect(pulsing(line('2026-11-18T00:10:00Z'), map, now)).toBe(false);
  expect(pulsing(line('2026-11-18T00:15:30Z'), map, now)).toBe(true);
  expect(pulsing(line('2026-11-18T00:14:30Z'), map, now, true)).toBe(false);
  expect(pulsing(line(null, { pulse: true }), map, now)).toBe(true);
  expect(pulsing(line(null, { pulse: true }), map, now, true)).toBe(false);
  expect(pulsing(line(null), map, now)).toBe(false);
});

it('aggregates both message directions, propagates unknown counts and excludes self and structural edges', () => {
  const edge = (from: string, to: string, messages: number | null, kind: LiveMapEdge['kind'] = 'messaged-in-last-15-min') =>
    line(null, { id: `${from}>${to}`, kind, from, to, messages });
  const first = edge('a', 'b', 2);
  const unknownPair = edge('a', 'c', 1);
  const pairs = messagePairs(full({ edges: [
    first, edge('b', 'a', 3), unknownPair, edge('c', 'a', null),
    edge('a', 'a', 9), edge('a', 'd', 4, 'reports-to'),
  ] }));
  expect(pairs).toEqual([
    { key: '["a","b"]', edge: first, count: 5 },
    { key: '["a","c"]', edge: unknownPair, count: null },
  ]);
});

it('bows same-row curves above nodes and cross-row curves sideways with their actual midpoints', () => {
  expect(messageCurve({ x: 0, y: 100 }, { x: 200, y: 100 })).toEqual({
    d: `M0,100 Q100,${100 - NODE_H - 36} 200,100`,
    mid: { x: 100, y: 100 - (NODE_H + 36) / 2 },
  });
  expect(messageCurve({ x: 0, y: 0 }, { x: 100, y: 200 })).toEqual({
    d: 'M0,0 Q90,60 100,200', mid: { x: 70, y: 80 },
  });
  expect(messageCurve({ x: 100, y: 0 }, { x: 0, y: 200 })).toEqual({
    d: 'M100,0 Q10,60 0,200', mid: { x: 30, y: 80 },
  });
});

it('boxes remote computers only and labels offline and unknown counts', () => {
  const computer = (id: string, x: number, status: string, remote?: boolean): PlacedNode => ({
    ...node(id, 'computer'), x, y: 200, status, ...(remote === undefined ? {} : { remote }),
  });
  expect(remoteGroup([computer('local', 100, 'ready')])).toEqual([]);
  expect(remoteGroup([
    computer('local', 100, 'ready'), computer('remote-b', 300, 'offline', true),
    computer('remote-c', 500, 'unknown', true), computer('remote-d', 700, 'ready', true),
    { ...node('lane:remote', 'lane'), x: 900, y: 200, remote: true },
  ])).toEqual([{
    id: 'remote-macs', label: 'Other Macs: 3, 1 offline, 1 unknown',
    x: 300 - NODE_W / 2 - 8, y: 200 - NODE_H / 2 - 24,
    width: 400 + NODE_W + 16, height: NODE_H + 32,
  }]);
});

it('labels organization boxes with running counts and reported unknown states', () => {
  expect(orgBoxLabel({ label: 'claude', counts: { running: 2, queued: 0, idle: 0, unknown: 0 } }))
    .toBe('claude: 2 running');
  expect(orgBoxLabel({ label: 'grok', counts: { running: 0, queued: 0, idle: 0, unknown: 3 } }))
    .toBe('grok: 0 running, 3 unknown');
});

it('remembers selected lane, repository and state filters within session storage', () => {
  expect(readMapFilter()).toEqual({});
  saveMapFilter({ lane: 'claude', repo: 'fixture/project', state: 'running' });
  expect(readMapFilter()).toEqual({ lane: 'claude', repo: 'fixture/project', state: 'running' });
  saveMapFilter({ lane: 'claude', repo: null, state: 'running' });
  expect(readMapFilter()).toEqual({ lane: 'claude', repo: null, state: 'running' });
});

it('nulls invalid saved filter fields and ignores malformed JSON and non-object values', () => {
  globalThis.sessionStorage.setItem(MAP_FILTER_KEY, JSON.stringify({ lane: 'x', state: 'bogus' }));
  expect(readMapFilter()).toEqual({ lane: 'x', repo: null, state: null });
  globalThis.sessionStorage.setItem(MAP_FILTER_KEY, JSON.stringify({ lane: 42, repo: [], state: 'done' }));
  expect(readMapFilter()).toEqual({ lane: null, repo: null, state: 'done' });
  for (const raw of ['{nope', '[]', 'null', '42', '"running"']) {
    globalThis.sessionStorage.setItem(MAP_FILTER_KEY, raw);
    expect(readMapFilter()).toEqual({});
  }
});

it('returns no filters and tolerates saves when storage methods throw', () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  expect(readMapFilter()).toEqual({});
  expect(get).toHaveBeenCalledWith(MAP_FILTER_KEY);
  expect(() => saveMapFilter({ lane: 'claude' })).not.toThrow();
  expect(set).toHaveBeenCalledWith(MAP_FILTER_KEY, JSON.stringify({ lane: 'claude' }));
});

it('returns no filters and tolerates saves when accessing session storage throws', () => {
  const storage = vi.spyOn(globalThis, 'sessionStorage', 'get').mockImplementation(() => { throw new Error('Storage denied'); });
  expect(readMapFilter()).toEqual({});
  expect(() => saveMapFilter({ state: 'running' })).not.toThrow();
  expect(storage).toHaveBeenCalledTimes(2);
});
