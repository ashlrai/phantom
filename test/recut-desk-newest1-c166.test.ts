import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isWithinQuietHours, summarizeHeld } from '../src/web-ui/components/notifications/quiet-hours.js';

describe('recut of #4821: quiet hours for desktop notifications', () => {
  it('handles windows that wrap past midnight and rejects malformed ones', () => {
    const win = { start: '22:00', end: '07:00' };
    expect(isWithinQuietHours(new Date(2026, 0, 1, 23, 0), win)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 0, 1, 6, 59), win)).toBe(true);
    expect(isWithinQuietHours(new Date(2026, 0, 1, 7, 0), win)).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 0, 1, 12, 0), win)).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 0, 1, 23, 0), null)).toBe(false);
    expect(isWithinQuietHours(new Date(2026, 0, 1, 23, 0), { start: '25:00', end: '07:00' })).toBe(false);
    expect(summarizeHeld(1)).toBe('1 update while quiet');
    expect(summarizeHeld(3)).toBe('3 updates while quiet');
  });

  it('mounts the row in Settings and gates the store on it, keeping hard asks audible', () => {
    const settings = readFileSync('src/web-ui/routes/verse/sections/SettingsSection.tsx', 'utf8');
    expect(settings).toContain('<QuietHoursRow />');
    const store = readFileSync('src/web-ui/components/notifications/notification-store.ts', 'utf8');
    expect(store).toContain('isWithinQuietHours(new Date(), loadQuietHours())');
    expect(store).toContain("['secrets', 'money', 'outside-send', 'destroy-data']");
  });
});
