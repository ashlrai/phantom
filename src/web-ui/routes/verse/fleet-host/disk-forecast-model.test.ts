import { expect, it } from 'vitest';
import { diskForecast } from '../../../../core/fleet/disk-forecast.js';
import { diskForecastCard } from './disk-forecast-model.js';

const base = diskForecast(null, null);
it('describes each status and avoids fabricated null numbers', () => {
  expect(diskForecastCard(base).line).toBe('Disk trend unknown: not enough samples');
  expect(diskForecastCard({ ...base, status: 'reached' })).toMatchObject({ line: 'Free disk is at or under 150 GB now', tone: 'bad' });
  expect(diskForecastCard({ ...base, status: 'not-falling' }).line).toBe('Free disk is not falling');
  expect(diskForecastCard({ ...base, status: 'projected' }).line).toBe('Disk trend unknown: not enough samples');
  expect(diskForecastCard(base).caption).toBe('0 samples · window unknown');
});
it('uses strict six and twenty-four hour thresholds', () => {
  const projected = { ...base, status: 'projected' as const, consumptionGbPerHour: 4.2, crossingAt: '2026-11-10T03:10:00Z' };
  for (const [hours, tone] of [[5.9, 'bad'], [6, 'warn'], [23.9, 'warn'], [24, 'ok']] as const) {
    expect(diskForecastCard({ ...projected, hoursUntilThreshold: hours }).tone).toBe(tone);
  }
  expect(diskForecastCard({ ...projected, hoursUntilThreshold: 9 }).line).toContain('in about 9 h');
});
