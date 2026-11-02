import { expect, it } from 'vitest';
import { matchesPosted, postedSourceLabel } from './inbox-post-model.js';

const entry = { at: '2026-10-31 00:13', source: 'Phantom desktop', priority: 'P0', text: 'Hello\nworld' };
it('matches normalized text from desktop sources only', () => {
  expect(matchesPosted(entry, '  Hello\r\nworld  ')).toBe(true);
  expect(matchesPosted({ ...entry, source: 'desktop' }, entry.text)).toBe(true);
  expect(matchesPosted({ ...entry, source: 'Telegram' }, entry.text)).toBe(false);
  expect(matchesPosted(entry, 'Hello')).toBe(false);
});
it('uses the shared source labels', () => {
  expect(postedSourceLabel('desktop')).toBe('Phantom desktop');
  expect(postedSourceLabel('telegram')).toBe('Telegram');
  expect(postedSourceLabel('custom')).toBe('custom');
});
