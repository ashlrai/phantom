import { describe, expect, it } from 'vitest';
import { ASK_TITLE_MAX, askLeaderDraft } from './feed-ask.js';
import type { FeedItem } from './feed-model.js';

const item = (over: Partial<FeedItem>): FeedItem => ({ id: 'x', at: '2026-01-01T00:00:00Z', kind: 'merge', title: 'Fix the thing', ...over });

describe('askLeaderDraft', () => {
  it('quotes the kind and title, then leaves a blank line', () => {
    expect(askLeaderDraft(item({}))).toBe('About: Merge "Fix the thing"\n\n');
  });
  it('references an https href', () => {
    expect(askLeaderDraft(item({ href: 'https://github.com/a/b/pull/1' }))).toBe('About: Merge "Fix the thing" (https://github.com/a/b/pull/1)\n\n');
  });
  it('drops http and other hrefs', () => {
    expect(askLeaderDraft(item({ href: 'http://example.com' }))).not.toContain('example.com');
    expect(askLeaderDraft(item({ href: 'javascript:alert(1)' }))).not.toContain('javascript');
  });
  it('caps the title at 160 characters', () => {
    const out = askLeaderDraft(item({ title: 'a'.repeat(500) }));
    expect(out).toBe(`About: Merge "${'a'.repeat(ASK_TITLE_MAX - 1)}…"\n\n`);
  });
  it('flattens a multiline title to one line', () => {
    expect(askLeaderDraft(item({ title: 'one\n\ntwo\r\n  three' }))).toBe('About: Merge "one two three"\n\n');
  });
});
