import { describe, expect, it } from 'vitest';
import type { AgentBusPage, AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { busAge, busBodyText, libraryBusLines, withReceiptTtl } from './library-bus-model.js';

const NOW = 10_000_000_000;
const row = (cursor: number, body: unknown, extra: { receivedAt?: number; ttl?: number; priority?: 'P0' | 'P1' | 'P2' | 'P3' } = {}): AgentBusReceipt => ({
  cursor, receivedAt: extra.receivedAt ?? NOW - 1000,
  envelope: { id: `m${cursor}`, from: 'a', to: 'b', priority: extra.priority ?? 'P2', ttl: extra.ttl ?? 3_600_000, body },
});
const page = (...messages: AgentBusReceipt[]): AgentBusPage => ({ v: 1, status: 'ok', messages, nextCursor: 99 });

describe('libraryBusLines', () => {
  it('returns nothing without a page', () => {
    expect(libraryBusLines(null, NOW)).toEqual([]);
  });

  it('orders newest cursor first and applies the limit', () => {
    const lines = libraryBusLines(page(row(1, 'one'), row(3, 'three'), row(2, 'two')), NOW, 2);
    expect(lines.map((l) => l.id)).toEqual(['m3', 'm2']);
    expect(libraryBusLines(page(...Array.from({ length: 12 }, (_, i) => row(i + 1, 'x'))), NOW)).toHaveLength(8);
  });

  it('drops messages whose ttl has run out', () => {
    const lines = libraryBusLines(page(row(1, 'old', { receivedAt: NOW - 5000, ttl: 1000 }), row(2, 'live')), NOW);
    expect(lines.map((l) => l.id)).toEqual(['m2']);
  });

  it('carries sender, recipient, priority and the first line only', () => {
    const [line] = libraryBusLines(page(row(1, 'first\nsecond', { priority: 'P0' })), NOW);
    expect(line).toEqual({ id: 'm1', from: 'a', to: 'b', priority: 'P0', text: 'first', age: 'just now' });
  });

  it('cuts long text to 160 characters with an ellipsis', () => {
    const [line] = libraryBusLines(page(row(1, 'x'.repeat(500))), NOW);
    expect(line.text).toHaveLength(160);
    expect(line.text.endsWith('…')).toBe(true);
    expect(libraryBusLines(page(row(1, 'y'.repeat(160))), NOW)[0].text).toBe('y'.repeat(160));
  });
});

describe('busBodyText', () => {
  it('uses a string body, then text, message, summary', () => {
    expect(busBodyText('hi')).toBe('hi');
    expect(busBodyText({ text: 't', message: 'm' })).toBe('t');
    expect(busBodyText({ message: 'm', summary: 's' })).toBe('m');
    expect(busBodyText({ summary: 's' })).toBe('s');
  });

  it('falls back to cut JSON for anything else', () => {
    expect(busBodyText({ n: 1 })).toBe('{"n":1}');
    expect(busBodyText({ text: 5 })).toBe('{"text":5}');
    expect(busBodyText([1, 2])).toBe('[1,2]');
    expect(busBodyText({ big: 'z'.repeat(400) })).toHaveLength(160);
  });
});

describe('busAge', () => {
  it('words the age', () => {
    expect(busAge(NOW - 30_000, NOW)).toBe('just now');
    expect(busAge(NOW + 5000, NOW)).toBe('just now');
    expect(busAge(NOW - 4 * 60_000, NOW)).toBe('4m ago');
    expect(busAge(NOW - 2 * 3_600_000 - 1000, NOW)).toBe('2h ago');
    expect(busAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });
});

describe('withReceiptTtl', () => {
  it('adds the time already spent so a remaining ttl is not read as expired', () => {
    const fetched = page(row(1, 'a', { receivedAt: NOW - 60_000, ttl: 30_000 }));
    expect(libraryBusLines(fetched, NOW)).toEqual([]);
    expect(libraryBusLines(withReceiptTtl(fetched, NOW), NOW)).toHaveLength(1);
  });
});
