import { expect, it } from 'vitest';
import { lanesTileCount } from './fleet-hub-model.js';

it('returns plain fraction when no lane is held', () => {
  expect(lanesTileCount([
    { lane: 'a', running: 34, target: 30, held: false },
    { lane: 'b', running: 0, target: 28, held: false },
  ])).toBe('34/58');
});

it('appends "· 1 held" when one lane is held', () => {
  expect(lanesTileCount([
    { lane: 'a', running: 34, target: 30, held: false },
    { lane: 'b', running: 0, target: 28, held: true },
  ])).toBe('34/58 · 1 held');
});

it('appends "· 2 held" when several lanes are held', () => {
  expect(lanesTileCount([
    { lane: 'a', running: 34, target: 30, held: true },
    { lane: 'b', running: 0, target: 28, held: true },
    { lane: 'c', running: 5, target: 10, held: false },
  ])).toBe('39/68 · 2 held');
});

it('returns "0/0" for empty lanes', () => {
  expect(lanesTileCount([])).toBe('0/0');
});

it('handles zero target with held', () => {
  expect(lanesTileCount([
    { lane: 'x', running: 1, target: 0, held: true },
  ])).toBe('1/0 · 1 held');
});
