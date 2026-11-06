import { expect, it, vi } from 'vitest';
import { HISTORY_KEY, loadHistory, pushHistory, recall } from './interject-history.js';

it('loads valid recent strings and tolerates malformed storage', () => {
  const storage = { getItem: vi.fn(() => JSON.stringify([1, 'valid', 'x'.repeat(6_001), ...Array.from({ length: 21 }, (_, i) => String(i))])) };
  expect(loadHistory(storage)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  storage.getItem.mockReturnValue('invalid');
  expect(loadHistory(storage)).toEqual([]);
  storage.getItem.mockReturnValue('{}');
  expect(loadHistory(storage)).toEqual([]);
});

it('pushes, caps and deduplicates only the newest entry', () => {
  const storage = { value: '', getItem() { return this.value || null; }, setItem(_key: string, value: string) { this.value = value; } };
  for (let i = 0; i < 21; i++) pushHistory(storage, String(i));
  pushHistory(storage, '20');
  expect(loadHistory(storage)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  pushHistory(storage, '1');
  expect(loadHistory(storage).at(-1)).toBe('1');
  pushHistory(storage, 'x'.repeat(6_001));
  expect(loadHistory(storage)).toHaveLength(20);
  expect(JSON.parse(storage.value)).toEqual(loadHistory(storage));
  expect(HISTORY_KEY).toBe('phantom.interject.history.v1');
});

it('walks backward and forward and returns to the live draft', () => {
  const history = ['first', 'second'];
  expect(recall([], null, 'up')).toEqual({ cursor: null, text: null });
  expect(recall(history, null, 'down')).toEqual({ cursor: null, text: null });
  expect(recall(history, null, 'up')).toEqual({ cursor: 1, text: 'second' });
  expect(recall(history, 1, 'up')).toEqual({ cursor: 0, text: 'first' });
  expect(recall(history, 0, 'up')).toEqual({ cursor: 0, text: 'first' });
  expect(recall(history, 0, 'down')).toEqual({ cursor: 1, text: 'second' });
  expect(recall(history, 1, 'down')).toEqual({ cursor: null, text: null });
});

it('tolerates storage failures', () => {
  const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(loadHistory(storage)).toEqual([]);
  expect(() => pushHistory(storage, 'hello')).not.toThrow();
});
