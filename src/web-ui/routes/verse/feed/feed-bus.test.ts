import { describe, expect, it } from 'vitest';
import type { AgentBusPage, AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { busAdapter, buildFeed, filterFeed } from './feed-model.js';

const T = Date.parse('2026-11-09T10:00:00.000Z');
const receipt = (id: string, priority: AgentBusReceipt['envelope']['priority'], body: unknown = { text: `note ${id}` }, receivedAt = T, cursor = 1): AgentBusReceipt =>
  ({ cursor, receivedAt, envelope: { id, from: 'claude-1', to: 'leader', priority, ttl: 60_000, body } });
const page = (...messages: AgentBusReceipt[]): AgentBusPage => ({ v: 1, status: 'ok', messages, nextCursor: messages.length });

describe('busAdapter', () => {
  it('keeps P0 and P1 and drops P2 and P3', () => {
    const items = busAdapter(page(receipt('a', 'P0'), receipt('b', 'P1'), receipt('c', 'P2'), receipt('d', 'P3')));
    expect(items.map(i => i.id)).toEqual(['bus:a', 'bus:b']);
    expect(items.every(i => i.kind === 'bus')).toBe(true);
  });

  it('labels "<from> → <to> · <priority>" and takes the title from the body text', () => {
    const [item] = busAdapter(page(receipt('a', 'P0', { text: 'CI is red\nmain broke at 10:00' })));
    expect(item).toEqual({ id: 'bus:a', at: '2026-11-09T10:00:00.000Z', kind: 'bus', title: 'CI is red', body: 'CI is red\nmain broke at 10:00', label: 'claude-1 → leader · P0' });
  });

  it('falls back to the JSON body and skips empty text', () => {
    expect(busAdapter(page(receipt('a', 'P1', { kind: 'ping' })))[0]!.title).toBe('{"kind":"ping"}');
    expect(busAdapter(page(receipt('b', 'P1', { text: '  ' }))).length).toBe(0);
  });

  it('gives nothing for null or undefined', () => {
    expect(busAdapter(null)).toEqual([]);
    expect(busAdapter(undefined)).toEqual([]);
  });
});

describe('buildFeed with the bus', () => {
  it('dedupes the same envelope seen on two pages', () => {
    const feed = buildFeed({ bus: page(receipt('a', 'P0', undefined, T, 1), receipt('a', 'P0', undefined, T, 2)) });
    expect(feed.map(i => i.id)).toEqual(['bus:a']);
  });

  it('drops a message whose receivedAt does not parse', () => {
    const feed = buildFeed({ bus: page(receipt('bad', 'P0', undefined, Number.NaN), receipt('ok', 'P0')) });
    expect(feed.map(i => i.id)).toEqual(['bus:ok']);
  });

  it('filters to the bus kind and leaves other feeds unchanged without it', () => {
    const feed = buildFeed({ bus: page(receipt('a', 'P1')) });
    expect(filterFeed(feed, 'bus')).toHaveLength(1);
    expect(filterFeed(feed, 'owner')).toHaveLength(0);
    expect(buildFeed({})).toEqual([]);
  });
});
