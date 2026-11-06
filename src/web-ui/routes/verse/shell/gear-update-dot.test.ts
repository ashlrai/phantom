import { describe, expect, it } from 'vitest';
import { gearUpdateSpoken, gearUpdateTone } from './gear-update-dot.js';

describe('gear update dot', () => {
  it.each([
    [null, null],
    ['Phantom 3.30.0 available', 'info'],
    ['Update held · open Settings', 'warning'],
    ['Update failed · open Settings', 'warning'],
  ] as const)('maps %s to %s', (label, tone) => {
    expect(gearUpdateTone(label)).toBe(tone);
  });

  it('describes the update in the gear button name', () => {
    expect(gearUpdateSpoken(null)).toBe('');
    expect(gearUpdateSpoken('Phantom 3.30.0 available')).toBe(', update: Phantom 3.30.0 available');
  });
});
