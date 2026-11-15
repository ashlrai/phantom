import { describe, expect, it } from 'vitest';
import { feedTellText } from './feed-tell-text.js';
import type { FeedItem } from './feed-model.js';

const item: FeedItem = { id: 'merge:example/repo#42', at: '2026-01-01T00:00:00Z', kind: 'merge', title: 'Fix feed', body: 'example/repo #42', href: 'https://github.com/example/repo/pull/42' };

describe('feedTellText', () => {
  it('includes the source and deduplicated references', () => {
    expect(feedTellText(item)).toBe('About feed item "Fix feed" (merge, #42): ');
    expect(feedTellText({ ...item, id: 'alert:1', kind: 'alert', title: 'RQ-FAKE-123 needs help', body: undefined, href: undefined }))
      .toBe('About feed item "RQ-FAKE-123 needs help" (alert, RQ-FAKE-123): ');
  });
  it('keeps titles on one line and caps them at 120 characters', () => {
    expect(feedTellText({ ...item, id: 'update:1', kind: 'update', title: `First\r\n${'x'.repeat(150)}`, body: undefined, href: undefined }))
      .toBe(`About feed item "First ${'x'.repeat(114)}" (update): `);
  });
});
