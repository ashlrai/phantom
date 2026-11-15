import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../../../components/notifications/types.js';
import { buildFeed, filterFeed, updateAdapter } from './feed-model.js';

const note = (id: string, title: string, ts: string, detail?: string): AppNotification => ({
  id, category: 'action-required', severity: 'high', title, detail: detail ?? '', ts, actionLabel: 'Update now', actionRun: () => {},
});
const T = '2026-11-09T10:00:00.000Z';

describe('updateAdapter', () => {
  it('maps ready, held, failed and applied news to plain update items', () => {
    const items = updateAdapter([
      note('update-ready:3.30.29', 'Phantom 3.30.29 is ready to install', T, 'Installs when idle.'),
      note('update-held:3.30.29', 'Update to 3.30.29 is held', T),
      note('update-failed:3.30.29:abc', 'Update to 3.30.29 failed: disk full', T),
      note('update-applied:abc1234', 'Now running abc1234', T),
    ]);
    expect(items.map(i => i.id)).toEqual(['update:update-ready:3.30.29', 'update:update-held:3.30.29', 'update:update-failed:3.30.29:abc', 'update:update-applied:abc1234']);
    expect(items.every(i => i.kind === 'update' && i.at === T)).toBe(true);
    expect(items[0]).toEqual({ id: 'update:update-ready:3.30.29', at: T, kind: 'update', title: 'Phantom 3.30.29 is ready to install', body: 'Installs when idle.' });
    expect(items[1]).not.toHaveProperty('body');
    expect(items.some(i => 'actionRun' in i)).toBe(false);
  });

  it('gives nothing for null, undefined or empty', () => {
    expect(updateAdapter(null)).toEqual([]);
    expect(updateAdapter(undefined)).toEqual([]);
    expect(updateAdapter([])).toEqual([]);
  });
});

describe('buildFeed with updates', () => {
  const runs = { mergesLastHour: { count: 1, items: [{ repo: 'a/b', number: 1, title: 'Merged', mergedAt: '2026-11-09T11:00:00.000Z' }] } };
  const owner = [{ seq: 1, id: 'o1', channel: 'telegram', senderId: '1', direction: 'inbound', at: '2026-11-09T09:00:00.000Z', text: 'Hi' }] as never;

  it('keeps one item for a repeated update id and orders it by time', () => {
    const dup = note('update-ready:3.30.29', 'Phantom 3.30.29 is ready to install', T);
    const feed = buildFeed({ runs, owner, update: [dup, dup] });
    expect(feed.map(i => i.kind)).toEqual(['merge', 'update', 'owner']);
  });

  it('filters to update items only', () => {
    const feed = buildFeed({ runs, owner, update: [note('update-ready:3.30.29', 'x', T)] });
    expect(filterFeed(feed, 'update').map(i => i.kind)).toEqual(['update']);
  });
});
