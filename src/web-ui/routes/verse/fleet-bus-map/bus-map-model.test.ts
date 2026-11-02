import { expect, it } from 'vitest';
import type { BusHop } from '../fleet/bus-feed-queries.js';
import { buildBusMap, topTalkers, truncateAgentId } from './bus-map-model.js';

const hop = (id: string, from: string, to: string, inputTokens: number | null = null, outputTokens: number | null = null): BusHop =>
  ({ id, from, to, inputTokens, outputTokens });

// Six hops across three agents: builder talks most, leader close behind, scout barely.
const sixHops: BusHop[] = [
  hop('1', 'leader', 'builder', 100, 10),
  hop('2', 'leader', 'builder', 200, null),
  hop('3', 'builder', 'leader', 50, 5),
  hop('4', 'leader', 'scout'),
  hop('5', 'scout', 'builder', 25, 7),
  hop('6', 'builder', 'leader', 75),
];

it('aggregates agents, pairs and totals from a six-hop window', () => {
  const map = buildBusMap(sixHops);
  expect(map.totals).toEqual({ hops: 6, inputTokens: 450, outputTokens: 22 });
  expect(map.agents).toEqual([
    { id: 'builder', sent: 2, received: 3, inputTokens: 125, outputTokens: 5 },
    { id: 'leader', sent: 3, received: 2, inputTokens: 300, outputTokens: 10 },
    { id: 'scout', sent: 1, received: 1, inputTokens: 25, outputTokens: 7 },
  ]);
  expect(map.pairs).toEqual([
    { from: 'builder', to: 'leader', hops: 2, inputTokens: 125, outputTokens: 5, share: 2 / 6 },
    { from: 'leader', to: 'builder', hops: 2, inputTokens: 300, outputTokens: 10, share: 2 / 6 },
    { from: 'leader', to: 'scout', hops: 1, inputTokens: null, outputTokens: null, share: 1 / 6 },
    { from: 'scout', to: 'builder', hops: 1, inputTokens: 25, outputTokens: 7, share: 1 / 6 },
  ]);
});

it('keeps hop directions separate and attributes tokens to the sender', () => {
  const map = buildBusMap([hop('1', 'a', 'b', 10, 1), hop('2', 'b', 'a', 20, 2)]);
  expect(map.pairs.map(p => `${p.from}>${p.to}`)).toEqual(['a>b', 'b>a']);
  expect(map.agents.find(a => a.id === 'a')).toMatchObject({ sent: 1, received: 1, inputTokens: 10 });
  expect(map.agents.find(a => a.id === 'b')).toMatchObject({ sent: 1, received: 1, inputTokens: 20 });
});

it('treats unknown token counts as unknown, not zero', () => {
  const map = buildBusMap([hop('1', 'a', 'b'), hop('2', 'a', 'b', 5, null)]);
  expect(map.pairs[0]).toMatchObject({ inputTokens: 5, outputTokens: null });
  expect(map.totals).toEqual({ hops: 2, inputTokens: 5, outputTokens: null });
  expect(buildBusMap([hop('1', 'a', 'b')]).totals).toEqual({ hops: 1, inputTokens: null, outputTokens: null });
});

it('returns null for a token sum that would leave safe-integer range', () => {
  const map = buildBusMap([
    hop('1', 'a', 'b', Number.MAX_SAFE_INTEGER, 3),
    hop('2', 'a', 'b', 1, Number.MAX_SAFE_INTEGER),
    hop('3', 'a', 'b', -4, 2), // negative counts are not valid usage
  ]);
  expect(map.totals.inputTokens).toBeNull();
  expect(map.totals.outputTokens).toBeNull();
  expect(map.totals.hops).toBe(3);
});

it('orders deterministically: traffic desc, id asc on ties', () => {
  // Two pairs tie on hops; two agents tie on sent+received. Order must not
  // depend on input order, so a poll delivering the same rows re-sorted
  // renders identically.
  const forward = [hop('1', 'zed', 'amy'), hop('2', 'amy', 'zed'), hop('3', 'zed', 'amy'), hop('4', 'amy', 'zed')];
  const shuffled = [forward[2], forward[0], forward[3], forward[1]];
  for (const hops of [forward, shuffled]) {
    const map = buildBusMap(hops);
    expect(map.pairs.map(p => `${p.from}>${p.to}`)).toEqual(['amy>zed', 'zed>amy']);
    expect(map.agents.map(a => a.id)).toEqual(['amy', 'zed']);
  }
  const empty = buildBusMap([]);
  expect(empty).toEqual({ agents: [], pairs: [], totals: { hops: 0, inputTokens: null, outputTokens: null } });
});

it('truncates long ids keeping both ends with a middle ellipsis', () => {
  const id = 'agent-leader-orchestrator-lane-01-primary';
  const short = truncateAgentId(id);
  expect(short).toBe('agent-leader…-01-primary');
  expect(short.length).toBe(24);
  expect(short.startsWith(id.slice(0, 12))).toBe(true);
  expect(short.endsWith(id.slice(-11))).toBe(true);
  expect(truncateAgentId('short-id')).toBe('short-id');
  expect(truncateAgentId('abcdef', 5)).toBe('ab…ef');
  expect(truncateAgentId('abcdef', 3)).toBe('a…f');
});

it('returns the busiest agents through topTalkers', () => {
  const { agents } = buildBusMap(sixHops);
  expect(topTalkers(agents, 2).map(a => a.id)).toEqual(['builder', 'leader']);
  expect(topTalkers(agents, 99)).toHaveLength(3);
  expect(topTalkers(agents, 0)).toEqual([]);
});
