import { describe, expect, it } from 'vitest';
import { isFeedItemVisible } from './feed-mute.js';
import type { FeedItem } from './feed-model.js';

const item: FeedItem = { id: '1', at: '2026-01-01T00:00:00Z', kind: 'merge', title: 'Merged' };
describe('feed mute', () => {
  it('hides muted routine items but preserves urgent and needs-you items', () => {
    expect(isFeedItemVisible(item, ['merge'])).toBe(false);
    expect(isFeedItemVisible(item, [])).toBe(true);
    expect(isFeedItemVisible({ ...item, severity: 'error' }, ['merge'])).toBe(true);
    expect(isFeedItemVisible({ ...item, severity: 'alert' }, ['merge'])).toBe(true);
    expect(isFeedItemVisible({ ...item, needsYou: true }, ['merge'])).toBe(true);
    expect(isFeedItemVisible({ ...item, kind: 'alert' }, ['alert'])).toBe(true);
  });
});
