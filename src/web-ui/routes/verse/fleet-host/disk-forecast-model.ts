import type { DiskForecast } from '../../../../core/fleet/disk-forecast.js';

const date = (value: string) => new Date(value).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export function diskForecastCard(f: DiskForecast) {
  let line = 'Disk trend unknown: not enough samples';
  let tone: 'bad' | 'warn' | 'ok' = 'ok';
  if (f.status === 'reached') { line = 'Free disk is at or under 150 GB now'; tone = 'bad'; }
  else if (f.status === 'not-falling') line = 'Free disk is not falling';
  else if (f.status === 'projected' && f.hoursUntilThreshold !== null && f.consumptionGbPerHour !== null && f.crossingAt !== null) {
    line = `Free disk reaches 150 GB in about ${Math.round(f.hoursUntilThreshold)} h (${date(f.crossingAt)}) at ${f.consumptionGbPerHour.toFixed(1)} GB/h`;
    tone = f.hoursUntilThreshold < 6 ? 'bad' : f.hoursUntilThreshold < 24 ? 'warn' : 'ok';
  }
  const window = f.observedFrom && f.observedTo ? `${date(f.observedFrom)} – ${date(f.observedTo)}` : 'window unknown';
  return { line, tone, caption: `${f.samples} ${f.samples === 1 ? 'sample' : 'samples'} · ${window}` };
}
