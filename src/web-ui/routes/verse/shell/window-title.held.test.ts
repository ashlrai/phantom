import { expect, it } from 'vitest';
import { formatWindowTitle } from './window-title.js';

const badge = { workers: 24, merges: 7, switchesOn: [] as string[], paused: false, heldLanes: [] as string[] };

it('shows paused status and worker count', () => {
  expect(formatWindowTitle({ badge: { ...badge, paused: true, workers: 0 } })).toBe('Phantom · ⏸ paused · 0 working');
});

it('shows one or several held lanes before switches', () => {
  expect(formatWindowTitle({ badge: { ...badge, heldLanes: ['cmp'] } })).toBe('Phantom · 24 working · 7 merged/h · cmp held');
  expect(formatWindowTitle({ badge: { ...badge, heldLanes: ['claude', 'cmp'], switchesOn: ['HOLD'] } }))
    .toBe('Phantom · 24 working · 7 merged/h · 2 lanes held · switches on');
});

it('caps long held lane titles at 80 characters', () => {
  const title = formatWindowTitle({ badge: { ...badge, heldLanes: ['x'.repeat(100)] } });
  expect(title).toHaveLength(80);
  expect(title.endsWith('…')).toBe(true);
});
