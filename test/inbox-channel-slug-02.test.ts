import { describe, expect, it } from 'vitest';
import { inboxChannelSlug } from '../src/core/fleet/inbox-channel-slug.js';

describe('inboxChannelSlug', () => {
  it('maps desktop names to desktop', () => {
    for (const name of ['Phantom desktop', 'Phantom desktop chat', 'Phantom desktop composer', 'desktop']) {
      expect(inboxChannelSlug(name)).toBe('desktop');
    }
  });
  it('maps phone and mobile names to phone', () => {
    for (const name of ['Phantom mobile', 'Phantom phone', 'mobile']) expect(inboxChannelSlug(name)).toBe('phone');
  });
  it('slugs an unknown name', () => {
    expect(inboxChannelSlug('Telegram')).toBe('telegram');
    expect(inboxChannelSlug('Relayed by Masbot')).toBe('relayed-by-masbot');
  });
  it('sanitises unsafe names and falls back to desktop', () => {
    const slug = inboxChannelSlug('../Evil]\n[src:x id:y] ' + 'z'.repeat(80));
    expect(slug).toMatch(/^[a-z0-9._-]{1,32}$/);
    expect(inboxChannelSlug('!!!')).toBe('desktop');
    expect(inboxChannelSlug('')).toBe('desktop');
  });
});
