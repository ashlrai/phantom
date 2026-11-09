/**
 * Map ashlr.world-model/v1 JSON onto one resource-bar row per lane.
 *
 * Numbers come only from a fresh field. A missing key, a null, a stale
 * freshness, or an observedAt past the usage-sensor staleness window is
 * unknown. Reset and the exhaustion verdict are read when the lane carries
 * them (pacing rows) and otherwise from the same document's observe window.
 * This module does not fetch, and it does not fill a gap with zero.
 */
import { USAGE_SENSOR_STALE_MS } from '../../../../core/usage/sensor-reading.js';

/** Same bound as usage.sensors.v1. A reading this old is not current. */
export const WORLD_LANE_STALE_MS = USAGE_SENSOR_STALE_MS;

export type LaneFreshness = 'fresh' | 'stale' | 'unknown';
export type LaneForecast = 'early' | 'on-pace' | 'underuse' | 'unknown';
export type LaneEngine = 'claude' | 'codex' | 'grok' | 'local' | 'devin' | 'cursor' | 'dot' | 'other';

export interface WorldLaneRow {
  key: string;
  lane: string;
  label: string;
  engine: LaneEngine;
  usage: string;
  remaining: string;
  reset: string;
  resetAt: string | null;
  burn: string;
  forecast: LaneForecast;
  forecastText: string;
  /** Hours-from-now of exhaustion, divided by hours-to-reset. Null when either time is unknown. */
  exhaustFraction: number | null;
  source: string;
  observedAt: string | null;
  freshness: LaneFreshness;
  age: string;
  summary: string;
}

interface Signal {
  present: boolean;
  value: number | string | null;
  source: string | null;
  observedAt: string | null;
  freshness: LaneFreshness;
}

interface LaneSpec {
  lane: string;
  label: string;
  engine: LaneEngine;
  match: readonly string[];
}

const CANONICAL: readonly LaneSpec[] = [
  { lane: 'claude-max', label: 'Claude subscription', engine: 'claude', match: ['claude-max', 'claude', 'claude-subscription'] },
  { lane: 'claude-api', label: 'Claude API', engine: 'claude', match: ['claude-api'] },
  { lane: 'codex-personal', label: 'Codex personal', engine: 'codex', match: ['codex-personal'] },
  { lane: 'devin', label: 'Devin', engine: 'devin', match: ['devin'] },
  { lane: 'dot', label: 'Dot', engine: 'dot', match: ['dot'] },
  { lane: 'grok-ultra', label: 'Grok', engine: 'grok', match: ['grok-ultra', 'grok'] },
  { lane: 'cursor-cloud', label: 'Cursor cloud', engine: 'cursor', match: ['cursor-cloud', 'cursor'] },
  { lane: 'local', label: 'Local / oMLX', engine: 'local', match: ['local', 'omlx', 'ollama'] },
];

const EXTRA: Readonly<Record<string, { label: string; engine: LaneEngine }>> = {
  'devin-swe-flash': { label: 'Devin SWE Flash', engine: 'devin' },
  'devin-weekly': { label: 'Devin weekly', engine: 'devin' },
  'codex-cmp': { label: 'Codex company', engine: 'codex' },
  'grok-bot': { label: 'Grok Bot', engine: 'grok' },
  terra: { label: 'Terra', engine: 'other' },
  omlx: { label: 'oMLX', engine: 'local' },
  ollama: { label: 'Ollama', engine: 'local' },
};

const ABSENT: Signal = { present: false, value: null, source: null, observedAt: null, freshness: 'unknown' };

/** The canonical lane a seat or lane id belongs to, by the same aliases the bar uses. */
export function canonicalLaneFor(id: string): string | null {
  return CANONICAL.find((spec) => spec.match.includes(id))?.lane ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isFreshness(value: unknown): value is LaneFreshness {
  return value === 'fresh' || value === 'stale' || value === 'unknown';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clock(nowMs: number): number {
  return Number.isFinite(nowMs) ? nowMs : Date.now();
}

function quantity(value: number): string {
  const digits = Math.abs(value) >= 100 ? 0 : 2;
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function unitSuffix(unit: string | null, perHour: boolean): string {
  const suffix = unit === 'percent' ? '%' : unit === 'acu' ? ' ACU' : unit ? ` ${unit}` : '';
  if (!perHour) return suffix;
  if (unit === 'percent') return '%/h';
  if (unit === 'acu') return ' ACU/h';
  if (unit) return ` ${unit}/h`;
  return '/h';
}

function safeUnit(value: string): string | null {
  return /^[A-Za-z%][A-Za-z0-9%._-]{0,24}$/.test(value) ? value : null;
}

export function observationAge(observedAt: string | null, nowMs: number): string {
  if (!observedAt) return 'unknown';
  const age = clock(nowMs) - Date.parse(observedAt);
  if (!Number.isFinite(age) || age < 0) return 'unknown';
  if (age < 60_000) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isoLabel(value: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const hours = date.getUTCHours();
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${h12}:${minutes} ${hours < 12 ? 'AM' : 'PM'} UTC`;
}

function forecastText(verdict: LaneForecast): string {
  switch (verdict) {
    case 'early':
      return 'exhausts before reset';
    case 'on-pace':
      return 'meets reset';
    case 'underuse':
      return 'allowance left at reset';
    case 'unknown':
      return 'unknown';
    default: {
      const never: never = verdict;
      return never;
    }
  }
}

function laneFreshness(lane: Record<string, unknown>): LaneFreshness {
  if (isFreshness(lane['freshness'])) return lane['freshness'];
  if (lane['stale'] === true) return 'stale';
  if (lane['status'] === 'fresh') return 'fresh';
  if (lane['status'] === 'unknown') return 'unknown';
  return 'unknown';
}

function readWrapped(raw: unknown): Signal {
  const record = asRecord(raw);
  if (!record || !isFreshness(record['freshness']) || !('value' in record)) return ABSENT;
  const source = typeof record['source'] === 'string' && record['source'].length > 0 ? record['source'] : null;
  const observedAt = typeof record['observedAt'] === 'string' && Number.isFinite(Date.parse(record['observedAt'])) ? record['observedAt'] : null;
  const freshness = record['freshness'];
  if (freshness !== 'fresh') return { present: true, value: null, source, observedAt, freshness };
  const numeric = finiteNumber(record['value']);
  if (numeric !== null) return { present: true, value: numeric, source, observedAt, freshness };
  if (typeof record['value'] === 'string') return { present: true, value: record['value'], source, observedAt, freshness };
  if (record['value'] === null) return { present: true, value: null, source, observedAt, freshness: 'unknown' };
  return { present: true, value: null, source, observedAt, freshness: 'unknown' };
}

function readLaneSignal(lane: Record<string, unknown>, key: string): Signal {
  if (!(key in lane)) return ABSENT;
  const wrapped = readWrapped(lane[key]);
  if (wrapped.present) return wrapped;
  const raw = lane[key];
  const freshness = laneFreshness(lane);
  const source = typeof lane['source'] === 'string' && lane['source'].length > 0 ? lane['source'] : null;
  const observedAt = typeof lane['observedAt'] === 'string' && Number.isFinite(Date.parse(lane['observedAt'])) ? lane['observedAt'] : null;
  if (raw === null) return { present: true, value: null, source, observedAt, freshness: freshness === 'fresh' ? 'unknown' : freshness };
  const numeric = finiteNumber(raw);
  const text = typeof raw === 'string' ? raw : null;
  if (numeric === null && text === null) return { present: true, value: null, source, observedAt, freshness: 'unknown' };
  if (freshness !== 'fresh') return { present: true, value: null, source, observedAt, freshness };
  return { present: true, value: numeric ?? text, source, observedAt, freshness: 'fresh' };
}

function windowFor(windows: readonly Record<string, unknown>[], lane: string): Record<string, unknown> | null {
  return windows.find((window) => window['lane'] === lane) ?? null;
}

function fromWindow(window: Record<string, unknown> | null, key: string): Signal {
  if (!window || !(key in window)) return ABSENT;
  const source = typeof window['source'] === 'string' && window['source'].length > 0 ? window['source'] : null;
  const observedAt = typeof window['observedAt'] === 'string' && Number.isFinite(Date.parse(window['observedAt'])) ? window['observedAt'] : null;
  const status = window['status'];
  const freshness: LaneFreshness = status === 'fresh' ? 'fresh' : 'unknown';
  const raw = window[key];
  if (freshness !== 'fresh') return { present: true, value: null, source, observedAt, freshness };
  if (raw === null) return { present: true, value: null, source, observedAt, freshness: 'unknown' };
  const numeric = finiteNumber(raw);
  if (numeric !== null) return { present: true, value: numeric, source, observedAt, freshness };
  if (typeof raw === 'string') return { present: true, value: raw, source, observedAt, freshness };
  return { present: true, value: null, source, observedAt, freshness: 'unknown' };
}

function ageOut(signal: Signal, nowMs: number, staleAfter: string | null): Signal {
  if (!signal.present) return signal;
  const observed = signal.observedAt ? Date.parse(signal.observedAt) : NaN;
  if (Number.isFinite(observed) && observed > nowMs) return { ...signal, value: null, freshness: 'unknown' };
  const deadline = staleAfter ? Date.parse(staleAfter) : NaN;
  const aged = (Number.isFinite(observed) && nowMs >= observed + WORLD_LANE_STALE_MS)
    || (Number.isFinite(deadline) && nowMs >= deadline);
  if (signal.freshness === 'stale' || aged) return { ...signal, value: null, freshness: 'stale' };
  return signal;
}

function measure(lane: Record<string, unknown>, windows: readonly Record<string, unknown>[], key: string, nowMs: number): Signal {
  const own = readLaneSignal(lane, key);
  if (own.present) return ageOut(own, nowMs, typeof lane['staleAfter'] === 'string' ? lane['staleAfter'] : null);
  const laneName = typeof lane['lane'] === 'string' ? lane['lane'] : '';
  const window = windowFor(windows, laneName);
  const deadline = window && typeof window['staleAfter'] === 'string' ? window['staleAfter'] : null;
  return ageOut(fromWindow(window, key), nowMs, deadline);
}

function numberText(signal: Signal, unit: string | null, kind: 'used' | 'remaining' | 'burn'): string {
  if (signal.freshness !== 'fresh' || typeof signal.value !== 'number') return 'unknown';
  const amount = quantity(signal.value);
  if (kind === 'burn') return `${amount}${unitSuffix(unit, true)}`;
  return `${amount}${unitSuffix(unit, false)}`;
}

function usageText(used: Signal, limit: Signal, unit: string | null): string {
  if (used.freshness !== 'fresh' || typeof used.value !== 'number') return 'unknown';
  if (unit !== 'percent' && limit.freshness === 'fresh' && typeof limit.value === 'number') {
    return `${quantity(used.value)} of ${quantity(limit.value)}${unitSuffix(unit, false)}`;
  }
  const suffix = unitSuffix(unit, false);
  return suffix ? `${quantity(used.value)}${suffix}` : `${quantity(used.value)} used`;
}

function verdictOf(signal: Signal): LaneForecast {
  if (signal.freshness !== 'fresh' || typeof signal.value !== 'string') return 'unknown';
  switch (signal.value) {
    case 'early':
    case 'on-pace':
    case 'underuse':
    case 'unknown':
      return signal.value;
    default:
      return 'unknown';
  }
}

function fractionOf(exhaustAt: Signal, resetAt: Signal, nowMs: number): number | null {
  if (exhaustAt.freshness !== 'fresh' || resetAt.freshness !== 'fresh') return null;
  if (typeof exhaustAt.value !== 'string' || typeof resetAt.value !== 'string') return null;
  const exhaust = Date.parse(exhaustAt.value);
  const reset = Date.parse(resetAt.value);
  const span = reset - nowMs;
  if (!Number.isFinite(exhaust) || !Number.isFinite(reset) || !(span > 0)) return null;
  return (exhaust - nowMs) / span;
}

function unitOf(lane: Record<string, unknown>, windows: readonly Record<string, unknown>[], nowMs: number): string | null {
  const own = measure(lane, windows, 'unit', nowMs);
  if (own.freshness === 'fresh' && typeof own.value === 'string') return safeUnit(own.value);
  if (own.present) return null;
  const laneName = typeof lane['lane'] === 'string' ? lane['lane'] : '';
  const window = windowFor(windows, laneName);
  if (!window || window['status'] !== 'fresh') return null;
  const observed = typeof window['observedAt'] === 'string' ? Date.parse(window['observedAt']) : NaN;
  const deadline = typeof window['staleAfter'] === 'string' ? Date.parse(window['staleAfter']) : NaN;
  if (Number.isFinite(observed) && (observed > nowMs || nowMs >= observed + WORLD_LANE_STALE_MS)) return null;
  if (Number.isFinite(deadline) && nowMs >= deadline) return null;
  if (typeof window['unit'] === 'string') return safeUnit(window['unit']);
  if (typeof window['remainingUnit'] === 'string') return safeUnit(window['remainingUnit']);
  return null;
}

function badgeOf(primary: Signal, nowMs: number): { freshness: LaneFreshness; observedAt: string | null; age: string } {
  const observedAt = primary.observedAt;
  if (primary.freshness === 'stale') return { freshness: 'stale', observedAt, age: observationAge(observedAt, nowMs) };
  if (primary.freshness === 'fresh' && observedAt) return { freshness: 'fresh', observedAt, age: observationAge(observedAt, nowMs) };
  return { freshness: 'unknown', observedAt, age: observationAge(observedAt, nowMs) };
}

function unknownRow(lane: string, label: string, engine: LaneEngine, key: string): WorldLaneRow {
  const summary = `${label}: usage unknown, remaining unknown, reset unknown, burn unknown, forecast unknown. Source unknown. Observed unknown.`;
  return {
    key, lane, label, engine, usage: 'unknown', remaining: 'unknown', reset: 'unknown', resetAt: null,
    burn: 'unknown', forecast: 'unknown', forecastText: 'unknown', exhaustFraction: null,
    source: 'unknown', observedAt: null, freshness: 'unknown', age: 'unknown', summary,
  };
}

function project(lane: Record<string, unknown>, label: string, engine: LaneEngine, windows: readonly Record<string, unknown>[], nowMs: number, key: string): WorldLaneRow {
  const laneName = typeof lane['lane'] === 'string' ? lane['lane'] : key;
  const used = measure(lane, windows, 'used', nowMs);
  const limit = measure(lane, windows, 'limit', nowMs);
  const remaining = measure(lane, windows, 'remaining', nowMs);
  const burn = measure(lane, windows, 'burnRate', nowMs);
  const reset = measure(lane, windows, 'resetAt', nowMs);
  const exhaust = measure(lane, windows, 'forecastExhaustAt', nowMs);
  const verdict = verdictOf(measure(lane, windows, 'forecastVsReset', nowMs));
  const unit = unitOf(lane, windows, nowMs);
  const primary = used.present ? used : remaining;
  const badge = badgeOf(primary, nowMs);
  const resetAt = reset.freshness === 'fresh' && typeof reset.value === 'string' && isoLabel(reset.value) ? reset.value : null;
  const usage = usageText(used, limit, unit);
  const remainingText = numberText(remaining, unit, 'remaining');
  const burnText = numberText(burn, unit, 'burn');
  const resetText = resetAt ? isoLabel(resetAt) ?? 'unknown' : 'unknown';
  const text = forecastText(verdict);
  const source = primary.source ?? 'unknown';
  const summary = `${label}: usage ${usage}, remaining ${remainingText}, reset ${resetText}, burn ${burnText}, forecast ${text}. Source ${source}. Observed ${badge.freshness}${badge.observedAt ? ` ${badge.observedAt}` : ''}.`;
  return {
    key, lane: laneName, label, engine, usage, remaining: remainingText, reset: resetText, resetAt,
    burn: burnText, forecast: verdict, forecastText: text, exhaustFraction: fractionOf(exhaust, reset, nowMs),
    source, observedAt: badge.observedAt, freshness: badge.freshness, age: badge.age, summary,
  };
}

function extractLanes(document: unknown): Record<string, unknown>[] {
  const sensors = asRecord(asRecord(document)?.['sensors']);
  const list = sensors?.['lanes'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    return record && typeof record['lane'] === 'string' && record['lane'].length > 0 ? [record] : [];
  });
}

function extractWindows(document: unknown): Record<string, unknown>[] {
  const views = asRecord(asRecord(document)?.['views']);
  const observe = asRecord(views?.['observe']);
  const usage = asRecord(observe?.['usage']);
  const list = usage?.['windows'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const record = asRecord(item);
    return record && typeof record['lane'] === 'string' ? [record] : [];
  });
}

function extraIdentity(lane: string): { label: string; engine: LaneEngine } {
  const known = EXTRA[lane] ?? CANONICAL.find((spec) => spec.lane === lane);
  if (known) return { label: known.label, engine: known.engine };
  if (lane.startsWith('claude')) return { label: lane, engine: 'claude' };
  if (lane.startsWith('codex')) return { label: lane, engine: 'codex' };
  if (lane.startsWith('devin')) return { label: lane, engine: 'devin' };
  if (lane.startsWith('grok')) return { label: lane, engine: 'grok' };
  if (lane.startsWith('cursor')) return { label: lane, engine: 'cursor' };
  if (lane === 'dot') return { label: 'Dot', engine: 'dot' };
  return { label: lane, engine: 'other' };
}

function findLane(lanes: readonly Record<string, unknown>[], names: readonly string[], used: ReadonlySet<number>): number {
  for (const name of names) {
    const index = lanes.findIndex((lane, i) => !used.has(i) && lane['lane'] === name);
    if (index !== -1) return index;
  }
  return -1;
}

/** One row per canonical lane, then any other lane the snapshot lists, in document order. */
export function worldLaneRows(document: unknown, nowMs: number): WorldLaneRow[] {
  const now = clock(nowMs);
  const lanes = extractLanes(document);
  const windows = extractWindows(document);
  const used = new Set<number>();
  const seen = new Map<string, number>();
  const keyFor = (lane: string): string => {
    const count = seen.get(lane) ?? 0;
    seen.set(lane, count + 1);
    return count === 0 ? lane : `${lane}:${count}`;
  };
  const rows: WorldLaneRow[] = [];
  for (const spec of CANONICAL) {
    const index = findLane(lanes, spec.match, used);
    if (index === -1) {
      rows.push(unknownRow(spec.lane, spec.label, spec.engine, keyFor(spec.lane)));
      continue;
    }
    used.add(index);
    rows.push(project(lanes[index]!, spec.label, spec.engine, windows, now, keyFor(spec.lane)));
  }
  lanes.forEach((lane, index) => {
    if (used.has(index)) return;
    const id = String(lane['lane']);
    const extra = extraIdentity(id);
    rows.push(project(lane, extra.label, extra.engine, windows, now, keyFor(id)));
  });
  return rows;
}

/** True when two mapped rows would paint the same pixels. */
export function sameWorldLaneRow(left: WorldLaneRow, right: WorldLaneRow): boolean {
  return left.key === right.key && left.lane === right.lane && left.label === right.label
    && left.engine === right.engine && left.usage === right.usage && left.remaining === right.remaining
    && left.reset === right.reset && left.resetAt === right.resetAt && left.burn === right.burn
    && left.forecast === right.forecast && left.forecastText === right.forecastText
    && left.exhaustFraction === right.exhaustFraction && left.source === right.source
    && left.observedAt === right.observedAt && left.freshness === right.freshness && left.age === right.age
    && left.summary === right.summary;
}
