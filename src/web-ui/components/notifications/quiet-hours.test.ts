import { describe, expect, it, beforeEach } from 'vitest';
import { isWithinQuietHours, loadQuietHours, QUIET_HOURS_KEY, summarizeHeld } from './quiet-hours.js';

describe('quiet hours', () => {
  beforeEach(() => localStorage.clear());
  it('handles midnight and excludes the end', () => {
    const window = { start: '22:00', end: '07:00' };
    expect(isWithinQuietHours(new Date(2026, 0, 1, 23), window)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 0, 2, 6, 59), window)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 0, 2, 7), window)).toBe(false);
    expect(isWithinQuietHours(new Date(), { start: '07:00', end: '07:00' })).toBe(false);
  });
  it('ignores malformed storage', () => {
    for (const raw of ['{', '{"start":"25:00","end":"07:00"}', '[]']) {
      localStorage.setItem(QUIET_HOURS_KEY, raw);
      expect(loadQuietHours()).toBeNull();
    }
    expect(summarizeHeld(1)).toBe('1 update while quiet');
  });
});
