import { expect, it } from 'vitest';
import { matchesPosted } from './inbox-post-model.js';

it('highlights composer posts but not identical messages from Telegram', () => {
  const entry = { at: '2026-10-31 00:13', source: 'Phantom desktop chat', priority: 'P0', text: 'Hello\nworld' };
  expect(matchesPosted(entry, '  Hello\r\nworld  ')).toBe(true);
  expect(matchesPosted({ ...entry, source: 'Telegram' }, entry.text)).toBe(false);
});
