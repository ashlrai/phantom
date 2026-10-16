import { describe, expect, it } from 'vitest';
import { dateTimeFormat, formatDateTime, formatNumber } from './locale-format.js';

const OPTIONS: Intl.DateTimeFormatOptions[] = [
  { hour: 'numeric', minute: '2-digit' },
  { weekday: 'short', hour: 'numeric', minute: '2-digit' },
  { weekday: 'short', month: 'short', day: 'numeric' },
  { month: 'short', day: 'numeric', timeZone: 'UTC' },
  { month: 'short', day: 'numeric', year: 'numeric' },
  { weekday: 'short', hour: 'numeric' },
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
];

describe('locale-format', () => {
  it('prints what toLocaleString / toLocaleDateString / toLocaleTimeString print', () => {
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.UTC(2026, i % 12, 1 + (i % 27), (i * 7) % 24, (i * 13) % 60));
      for (const options of OPTIONS) {
        for (const locale of ['en-US', undefined]) {
          expect(formatDateTime(d, locale, options)).toBe(d.toLocaleString(locale, options));
          expect(formatDateTime(d.getTime(), locale, options)).toBe(d.toLocaleString(locale, options));
        }
      }
      expect(formatDateTime(d, 'en-US', { month: 'short', day: 'numeric' })).toBe(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      expect(formatDateTime(d, 'en-US', { hour: 'numeric', minute: '2-digit' })).toBe(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    }
  });

  it('reads "Invalid Date" for an invalid date instead of throwing, like toLocaleString', () => {
    const bad = new Date('not a date');
    expect(formatDateTime(bad, 'en-US', { month: 'short' })).toBe(bad.toLocaleString('en-US', { month: 'short' }));
    expect(formatDateTime(Number.NaN, 'en-US', { month: 'short' })).toBe('Invalid Date');
    expect(formatDateTime(Number.POSITIVE_INFINITY, 'en-US', { month: 'short' })).toBe('Invalid Date');
  });

  it('keeps one formatter per locale and options', () => {
    expect(dateTimeFormat('en-US', { hour: 'numeric' })).toBe(dateTimeFormat('en-US', { hour: 'numeric' }));
    expect(dateTimeFormat('en-US', { hour: 'numeric' })).not.toBe(dateTimeFormat('en-US', { hour: '2-digit' }));
  });

  it('formats numbers as toLocaleString does', () => {
    for (const n of [0, 0.12345, 12934.567, -4.5, 1e9]) {
      expect(formatNumber(n, 'en-US', { maximumFractionDigits: 2 })).toBe(n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
      expect(formatNumber(n, 'en-US')).toBe(n.toLocaleString('en-US'));
    }
  });
});
