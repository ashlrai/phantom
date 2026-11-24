import { expect, it } from 'vitest';
import { isFlagOnlyText } from '../leader-thread/thread-noise-model.js';
import { inboxEntryKind, partitionInboxNoise } from './inbox-noise-model.js';

it.each(['Phantom status', 'status?', '/status@bot', "what's running"])('treats %j as a status ask', text => {
  expect(inboxEntryKind({ text })).toBe('status-ask');
});
it.each(['--help', '--json --verbose'])('treats %j as a misfire', text => {
  expect(inboxEntryKind({ text })).toBe('misfire');
});
it('keeps a long order that mentions status as an order', () => {
  expect(inboxEntryKind({ text: 'Phantom status: merge #5315 after the import-closure fix' })).toBe('order');
});
it('treats empty text as a misfire, matching isFlagOnlyText', () => {
  expect(isFlagOnlyText('')).toBe(true);
  expect(inboxEntryKind({ text: '  ' })).toBe('misfire');
});
it('partitions while keeping input order', () => {
  const list = [{ text: 'a real order', n: 1 }, { text: '--help', n: 2 }, { text: 'second order', n: 3 }, { text: 'status', n: 4 }];
  const { orders, noise } = partitionInboxNoise(list);
  expect(orders.map(e => e.n)).toEqual([1, 3]);
  expect(noise.map(e => e.n)).toEqual([2, 4]);
});
