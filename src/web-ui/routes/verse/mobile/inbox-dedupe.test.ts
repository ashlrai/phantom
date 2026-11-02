import { describe, expect, it } from 'vitest';
import { dedupeInboxEntries } from './inbox-dedupe.js';

const entry = (at: string, source: string, text: string) => ({ at, source, text });

describe('dedupeInboxEntries', () => {
  it('keeps the earliest delivery and attributes distinct sources in input order', () => {
    const newest = entry('2026-10-31T12:00:00Z', 'Telegram', 'Hello!');
    const middle = entry('2026-10-31T11:00:00Z', 'email', '[email] Hello.');
    const oldest = entry('2026-10-31T10:00:00Z', 'Phantom mobile', 'Hello');
    expect(dedupeInboxEntries([newest, middle, oldest])).toEqual([
      { entry: oldest, repeats: 3, otherSources: ['Telegram', 'email'] },
    ]);
  });

  it('keeps messages seven hours apart separate and honors a custom window', () => {
    const entries = [entry('2026-10-31T10:00:00Z', 'a', 'Hello'), entry('2026-10-31T17:00:00Z', 'b', 'Hello')];
    expect(dedupeInboxEntries(entries)).toHaveLength(2);
    expect(dedupeInboxEntries(entries, 7 * 60 * 60 * 1000)).toHaveLength(1);
  });

  it('normalizes whitespace, case, tags and trailing punctuation', () => {
    const entries = [entry('2026-10-31T10:00:00Z', 'a', ' [Telegram] Hello\n WORLD?! '), entry('2026-10-31T10:01:00Z', 'b', 'hello world')];
    expect(dedupeInboxEntries(entries)[0]?.repeats).toBe(2);
  });

  it('keeps different text and unparseable timestamps separate', () => {
    const entries = [entry('2026-10-31T10:00:00Z', 'a', 'Hello'), entry('2026-10-31T10:01:00Z', 'b', 'Goodbye'), entry('unknown', 'c', 'Hello'), entry('unknown', 'd', 'Hello')];
    expect(dedupeInboxEntries(entries)).toHaveLength(4);
  });

  it('does not merge a chain spanning more than the window, and preserves group order', () => {
    const entries = [entry('2026-10-31T12:00:00Z', 'a', 'Hello'), entry('2026-10-31T12:00:00Z', 'b', 'Other'), entry('2026-10-31T07:00:00Z', 'c', 'Hello'), entry('2026-10-31T02:00:00Z', 'd', 'Hello')];
    expect(dedupeInboxEntries(entries).map(({ entry: item, repeats }) => [item.source, repeats])).toEqual([['c', 2], ['b', 1], ['d', 1]]);
  });

  it('counts repeated deliveries from the same source without attributing it twice', () => {
    const entries = [entry('2026-10-31T10:00:00Z', 'Email', 'Hello'), entry('2026-10-31T10:01:00Z', 'email', 'Hello')];
    expect(dedupeInboxEntries(entries)[0]).toEqual({ entry: entries[0], repeats: 2, otherSources: [] });
  });
});
