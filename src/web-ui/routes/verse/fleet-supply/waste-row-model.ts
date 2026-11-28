/**
 * routes/verse/fleet-supply/waste-row-model.ts: one weekly window of the Supply board's waste forecast, as the
 * row the board draws: the figure, the shares for the shared WindowBar, the sentence a screen reader hears and
 * the facts under the bar. Pure; `nowMs` is passed in.
 *
 * Nothing is projected without a measured burn. The ledger then only says how much is not used yet, so the
 * figure reads "up to N%" and the bar draws the used share alone. The time mark counts seven days back from the
 * reset, the same rule the Usage board applies to a window the server calls weekly; a reset more than seven
 * days out gets no mark.
 */
import { elapsedWords, leadWords, windowPace } from '../fleet-usage/window-pace-model.js';
import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';
import { wasteBar } from './supply-board-model.js';
import { resetText, type WasteForecast } from './waste-forecast-model.js';

const WEEK_MS = 7 * 86_400_000;
const format = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

export interface WasteRow {
  lane: string;
  tone: WasteForecast['tone'];
  verdict: 'High' | 'Watch' | 'On track';
  /** "38% unused at reset", or "up to 60% unused at reset" when no burn was measured. */
  figure: string;
  /** Shares for WindowBar; null = not drawn. `used` is null only when the reading is not a number. */
  used: number | null;
  more: number | null;
  unused: number | null;
  elapsed: number | null;
  /** The bar in words. */
  valueText: string;
  /** Under the bar, in reading order: reset, burn needed, burn measured, time gone, hold. */
  facts: string[];
}

export function wasteRow(forecast: WasteForecast, lane: ResourceLaneRow, nowMs: number): WasteRow {
  const bar = wasteBar(lane.usedPct, forecast.unusedPct, forecast.burnKnown);
  const resetMs = lane.resetAt === null ? NaN : Date.parse(lane.resetAt);
  const pace = Number.isFinite(resetMs) ? windowPace({
    usedPercent: lane.usedPct, resetsAt: lane.resetAt, limitReached: false, measured: true,
    period: { startsAt: new Date(resetMs - WEEK_MS).toISOString(), basis: 'weekly' },
  }, nowMs) : null;
  const lead = pace ? leadWords(pace) : null;
  const facts = [
    Number.isFinite(resetMs) ? `resets ${resetText(resetMs, forecast.hoursToReset)}` : null,
    forecast.tone === 'ok' ? null : `needs ${format(forecast.neededBurnPctPerHour)}%/h to use it all`,
    `burning ${forecast.burnKnown && lane.burnPctPerHour !== null ? `${format(lane.burnPctPerHour)}%/h` : 'unknown'}`,
    pace ? `${elapsedWords(pace)}${lead ? `, ${lead}` : ''}` : null,
    lane.held ? 'held, nothing will burn' : null,
  ].filter((fact): fact is string => fact !== null);
  const figure = `${forecast.burnKnown ? '' : 'up to '}${format(forecast.unusedPct)}% unused at reset`;
  return {
    lane: forecast.lane, tone: forecast.tone,
    verdict: forecast.tone === 'bad' ? 'High' : forecast.tone === 'warn' ? 'Watch' : 'On track',
    figure,
    used: bar ? bar.usedPct : null,
    more: bar && forecast.burnKnown ? bar.burnPct : null,
    unused: bar && forecast.burnKnown ? bar.unusedPct : null,
    elapsed: pace ? pace.elapsedPct : null,
    valueText: bar
      ? `${forecast.burnKnown ? bar.label : `${Math.round(bar.usedPct)}% used, burn unknown, up to ${Math.round(bar.unusedPct)}% unused`}${pace ? `; ${elapsedWords(pace)}` : ''}`
      : 'usage unknown',
    facts,
  };
}
