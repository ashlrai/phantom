import { describe, expect, it } from 'vitest';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { asksForEarlier, canLoadEarlier, earlierLine, earlierShown, joinThread } from './leader-earlier-model.js';

const NOW = Date.parse('2026-11-18T18:00:00Z');

describe('joinThread', () => {
  it('keeps each id once, at its first place, with its newest content', () => {
    const joined = joinThread(
      [msg({ id: 'a', text: 'first' }), msg({ id: 'b', text: 'asked' })],
      [msg({ id: 'b', text: 'answered' }), msg({ id: 'c', text: 'third' })],
    );
    expect(joined.map(m => `${m.id}:${m.text}`)).toEqual(['a:first', 'b:answered', 'c:third']);
  });

  it('is unchanged by joining the same page again', () => {
    const page = [msg({ id: 'a' }), msg({ id: 'b' })];
    expect(joinThread(joinThread([], page), page).map(m => m.id)).toEqual(['a', 'b']);
  });
});

describe('canLoadEarlier and earlierShown', () => {
  it('treats a newest page shorter than the page size as the whole thread', () => {
    expect(canLoadEarlier('idle', 12, 0, 50)).toBe(false);
    expect(earlierShown('idle', 12, 0, 50)).toBe(false);
  });

  it('offers the page before a full newest page, and after any earlier page', () => {
    expect(canLoadEarlier('idle', 50, 0, 50)).toBe(true);
    expect(canLoadEarlier('idle', 3, 50, 50)).toBe(true);
    expect(canLoadEarlier('error', 50, 0, 50)).toBe(true);
  });

  it('offers nothing while loading or at the start', () => {
    expect(canLoadEarlier('loading', 50, 0, 50)).toBe(false);
    expect(canLoadEarlier('done', 50, 20, 50)).toBe(false);
    expect(earlierShown('done', 50, 0, 50)).toBe(true);
  });
});

describe('earlierLine', () => {
  const view = { state: 'idle' as const, total: 50, earlierCount: 0, oldestAt: '2026-11-18T09:00:00Z', reason: null };

  it('says how many messages the newest page holds', () => {
    expect(earlierLine(view, NOW)).toBe('Newest 50 thread messages shown');
  });

  it('says how far back the loaded pages reach', () => {
    expect(earlierLine({ ...view, total: 100, earlierCount: 50, oldestAt: new Date(NOW - 86_400_000).toISOString() }, NOW)).toBe('100 thread messages, back to Yesterday');
  });

  it('does not guess a day for an unreadable time', () => {
    expect(earlierLine({ ...view, total: 100, earlierCount: 50, oldestAt: 'not a time' }, NOW)).toBe('100 thread messages, back to a time unknown');
    expect(earlierLine({ ...view, total: 100, earlierCount: 50, oldestAt: null }, NOW)).toBe('100 thread messages, back to a time unknown');
  });

  it('names the start of what is held, and the empty case', () => {
    expect(earlierLine({ ...view, state: 'done', total: 71, earlierCount: 21 }, NOW)).toBe('Start of the conversation held here · 71 thread messages');
    expect(earlierLine({ ...view, state: 'done' }, NOW)).toBe('No earlier messages are held here.');
  });

  it('carries the failed read’s own reason', () => {
    expect(earlierLine({ ...view, state: 'error', reason: 'The server did not answer.' }, NOW)).toBe('Earlier messages did not load. The server did not answer.');
    expect(earlierLine({ ...view, state: 'loading' }, NOW)).toBe('Loading earlier messages…');
  });
});

describe('asksForEarlier', () => {
  it('answers only to the keys that move up', () => {
    expect(['ArrowUp', 'PageUp', 'Home'].every(asksForEarlier)).toBe(true);
    expect(['ArrowDown', 'End', 'k', 'Enter'].some(asksForEarlier)).toBe(false);
  });
});
