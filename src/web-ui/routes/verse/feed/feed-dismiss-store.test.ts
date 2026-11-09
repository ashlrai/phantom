import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_DISMISS_CAP, FEED_DISMISS_STORAGE_KEY, dismiss, fingerprintOf, isDismissed, readStored, resetFeedDismissals, restore, restoreAll, writeStored } from './feed-dismiss-store.js';
import type { FeedItem } from './feed-model.js';

const item = (over: Partial<FeedItem> = {}): FeedItem => ({ id: 'leader:a', at: '2026-01-01T00:00:00.000Z', kind: 'leader', title: 'Fake note', ...over });
const urgent = (over: Partial<FeedItem> = {}): FeedItem => item({ id: 'alert:x', kind: 'alert', title: 'Fake alert', ...over });

beforeEach(() => { localStorage.clear(); resetFeedDismissals(); });

describe('feed dismissals', () => {
  it('round-trips through storage', () => {
    writeStored(dismiss({}, item()));
    resetFeedDismissals();
    expect(isDismissed(item(), readStored())).toBe(true);
    expect(Object.keys(JSON.parse(localStorage.getItem(FEED_DISMISS_STORAGE_KEY)!))).toEqual(['leader:a']);
  });

  it('keeps a normal item dismissed even when its time and text change', () => {
    const map = dismiss({}, item());
    expect(isDismissed(item({ at: '2026-02-02T00:00:00.000Z', title: 'Changed' }), map)).toBe(true);
  });

  it('brings an urgent item back when its text or time changes', () => {
    const map = dismiss({}, urgent());
    expect(isDismissed(urgent(), map)).toBe(true);
    expect(isDismissed(urgent({ title: 'Fake alert, worse' }), map)).toBe(false);
    expect(isDismissed(urgent({ body: 'more' }), map)).toBe(false);
    expect(isDismissed(urgent({ at: '2026-01-02T00:00:00.000Z' }), map)).toBe(false);
    expect(fingerprintOf(urgent())).not.toBe(urgent().id);
  });

  it('caps at 500 entries, dropping the oldest', () => {
    let map = {};
    for (let i = 0; i < FEED_DISMISS_CAP + 5; i++) map = dismiss(map, item({ id: `leader:${i}` }));
    expect(Object.keys(map)).toHaveLength(FEED_DISMISS_CAP);
    expect(isDismissed(item({ id: 'leader:0' }), map)).toBe(false);
    expect(isDismissed(item({ id: `leader:${FEED_DISMISS_CAP + 4}` }), map)).toBe(true);
  });

  it('restores one item or all', () => {
    const map = dismiss(dismiss({}, item()), item({ id: 'leader:b' }));
    expect(isDismissed(item(), restore(map, item()))).toBe(false);
    writeStored(map);
    restoreAll();
    expect(readStored()).toEqual({});
  });

  it.each(['{not json', '[1,2]', 'null', '"s"', '{"a":1,"leader:a":"leader:a"}'])('treats corrupt storage %s as empty or drops bad entries', (raw) => {
    localStorage.setItem(FEED_DISMISS_STORAGE_KEY, raw);
    resetFeedDismissals();
    expect(Object.keys(readStored()).filter(k => k !== 'leader:a')).toEqual([]);
  });

  it('never throws when storage is unavailable', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    resetFeedDismissals();
    expect(readStored()).toEqual({});
    expect(() => writeStored(dismiss({}, item()))).not.toThrow();
    get.mockRestore(); set.mockRestore();
  });
});
