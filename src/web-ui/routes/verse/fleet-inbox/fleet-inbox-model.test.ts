import { describe, expect, it } from 'vitest';
import { filterEntries, groupByDay, quoteForMessage, readInboxEntries } from './fleet-inbox-model.js';
const entry = { at: '2026-01-01 23:59', source: 'terminal', priority: 'P1', text: 'First\nsecond' };
describe('inbox model', () => {
  it('prefers all 100 route entries over the snapshot', () => {
    const entries = Array.from({ length: 100 }, () => entry);
    const result = readInboxEntries({ v: 1, sourceState: 'healthy', entries }, { v: 1, inbox: [] });
    expect(result.origin).toBe('route');
    expect(result.entries).toHaveLength(100);
  });
  it('narrows unknown payloads and keeps snapshot health', () => {
    expect(readInboxEntries(null, {}).origin).toBe('none');
    const result = readInboxEntries({ entries: [] }, { v: 1, sources: { inbox: 'degraded' }, inbox: [null, {}, { text: 'order' }] });
    expect(result).toEqual({ origin: 'snapshot', sourceState: 'degraded', entries: [{ at: '—', source: '—', priority: '—', text: 'order' }] });
    expect(readInboxEntries({ v: 1, entries: [] }, { v: 1, inbox: [entry] }).entries).toEqual([]);
  });
  it('groups and sorts ET stamps across a year boundary', () => {
    const newer = { ...entry, at: '2026-01-02 00:01' };
    const older = { ...entry, at: '2025-12-31 12:00' };
    expect(groupByDay([older, entry, newer], '2026-01-02').map(g => [g.label, g.entries[0].at])).toEqual([
      ['Today', newer.at], ['Yesterday', entry.at], ['2025-12-31', older.at],
    ]);
    expect(groupByDay([older], '2026-01-01')[0].label).toBe('Yesterday');
  });
  it('combines filters and quotes every line', () => {
    expect(filterEntries([entry], { source: 'terminal', text: 'SECOND' })).toEqual([entry]);
    expect(filterEntries([entry], { source: 'Telegram', text: '' })).toEqual([]);
    expect(quoteForMessage(entry)).toBe('> First\n> second\n— terminal, 2026-01-01 23:59 ET');
  });
});
