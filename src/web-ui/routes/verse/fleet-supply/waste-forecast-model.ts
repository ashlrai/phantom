import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';

export interface WasteForecast {
  lane: string;
  unusedPct: number;
  hoursToReset: number;
  burnKnown: boolean;
  neededBurnPctPerHour: number;
  tone: 'bad' | 'warn' | 'ok';
  text: string;
}

export function suggestedTarget(
  forecast: WasteForecast,
  lane: { running: number; target: number; held: boolean },
  burnPctPerHour: number | null,
): { target: number; perWorkerPctPerHour: number } | null {
  if (!forecast.burnKnown || burnPctPerHour === null || lane.running <= 0 || forecast.tone === 'ok' || lane.held) return null;
  // Split observed burn evenly across running workers; the forecast re-checks every poll.
  const perWorkerPctPerHour = burnPctPerHour / lane.running;
  const target = Math.min(64, Math.max(lane.target, Math.ceil(forecast.neededBurnPctPerHour / perWorkerPctPerHour)));
  return target <= lane.target ? null : { target, perWorkerPctPerHour };
}

const format = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

function resetText(atMs: number, hours: number): string {
  if (hours >= 24) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(atMs).replace(',', '');
  }
  const minutes = Math.ceil(hours * 60);
  const wholeHours = Math.floor(minutes / 60);
  return `in ${wholeHours ? `${wholeHours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`}`;
}

export function wasteForecast(lane: ResourceLaneRow, nowMs: number): WasteForecast | null {
  if (lane.window !== 'weekly' || lane.usedPct === null || lane.resetAt === null) return null;
  const resetMs = Date.parse(lane.resetAt);
  const hoursToReset = (resetMs - nowMs) / 3_600_000;
  if (!Number.isFinite(hoursToReset) || hoursToReset <= 0) return null;
  const burnKnown = lane.burnPctPerHour !== null;
  const burn = lane.burnPctPerHour ?? 0;
  const unusedPct = Math.max(0, Math.min(100, 100 - lane.usedPct - burn * hoursToReset));
  const neededBurnPctPerHour = (100 - lane.usedPct) / hoursToReset;
  const tone = unusedPct >= 50 ? 'bad' : unusedPct >= 15 ? 'warn' : 'ok';
  const needed = tone === 'ok' ? '' : ` · needs ${format(neededBurnPctPerHour)}%/h`;
  const burning = burnKnown ? `${format(burn)}%/h` : 'unknown';
  const text = `${lane.lane}: ${format(unusedPct)}% unused at reset (${resetText(resetMs, hoursToReset)})${needed} · burning ${burning}${lane.held ? ' · held, nothing will burn' : ''}`;
  return { lane: lane.lane, unusedPct, hoursToReset, burnKnown, neededBurnPctPerHour, tone, text };
}

export function wasteHeadline(forecasts: readonly WasteForecast[]): string | null {
  if (forecasts.length === 0) return null;
  const atRisk = forecasts.filter(forecast => forecast.unusedPct >= 15);
  if (atRisk.length === 0) return 'Waste forecast: on track';
  const total = atRisk.reduce((sum, forecast) => sum + forecast.unusedPct, 0);
  return `Waste forecast: ${format(total)} points unused across ${atRisk.length} ${atRisk.length === 1 ? 'lane' : 'lanes'}`;
}
