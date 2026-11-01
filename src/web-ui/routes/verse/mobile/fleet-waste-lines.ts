import { wasteForecast, wasteHeadline } from '../fleet-supply/waste-forecast-model.js';
import type { ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';

export function wasteLines(ledger: ResourceLedgerV1 | null | undefined, nowMs: number): {
  headline: string | null;
  rows: { lane: string; tone: 'bad' | 'warn' | 'ok'; text: string }[];
} {
  const forecasts = (ledger?.lanes ?? [])
    .map((lane) => wasteForecast(lane, nowMs))
    .filter((forecast) => forecast !== null);
  const headline = wasteHeadline(forecasts);
  const rows = forecasts
    .sort((a, b) => b.unusedPct - a.unusedPct)
    .slice(0, 4)
    .map(({ lane, tone, text }) => ({ lane, tone, text: text.length > 90 ? `${text.slice(0, 89)}…` : text }));
  return { headline, rows };
}
