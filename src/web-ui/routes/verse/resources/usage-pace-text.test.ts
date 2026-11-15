import { expect, it } from 'vitest';
import { paceForecastText } from './usage-pace-text.js';

it('says how much goes unused, or that it will all be used', () => {
  expect(paceForecastText({ projectedPercent: 62, hoursLeft: 40, unusedPercent: 38 })).toContain('about 38% unused at reset');
  expect(paceForecastText({ projectedPercent: 97, hoursLeft: 40, unusedPercent: 3 })).toContain('on track to use it all');
  expect(paceForecastText({ projectedPercent: 62, hoursLeft: 40 })).toContain('about 38% unused at reset');
});
it('keeps unknown evidence unknown', () => {
  expect(paceForecastText({ projectedPercent: null, hoursLeft: null, unusedPercent: null })).toBe('unknown');
  expect(paceForecastText(null)).toBe('unknown');
  expect(paceForecastText({ projectedPercent: 62, hoursLeft: 40 }, false)).toBe('unknown');
});
