import { expect, it } from 'vitest';
import { findMatches, matchLabel, nextMatch } from './log-find-model.js';

it('finds literal, case-insensitive substrings and ignores an empty query', () => {
  const lines = ['ERROR one', 'okay', 'error two', 'Error [three]'];
  expect(findMatches(lines, 'error')).toEqual([0, 2, 3]);
  expect(findMatches(lines, '[three]')).toEqual([3]);
  expect(findMatches(lines, '')).toEqual([]);
  expect(findMatches(lines, 'absent')).toEqual([]);
});

it('wraps in both directions and formats the current position', () => {
  const matches = [0, 2, 3];
  expect(nextMatch(matches, 3, 1)).toBe(0);
  expect(nextMatch(matches, 0, -1)).toBe(3);
  expect(nextMatch(matches, null, 1)).toBe(0);
  expect(nextMatch([], null, 1)).toBeNull();
  expect(matchLabel(matches, 3)).toBe('3 of 3');
  expect(matchLabel([], null)).toBe('No matches');
  expect(matchLabel(matches, null)).toBe('');
});
