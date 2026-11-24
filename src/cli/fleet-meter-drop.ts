/** Read-only meter-drop report: each provider's usage meter must visibly move
 *  between its two timed samples or the provider is an incident candidate. A
 *  meter flat for an observed hour while its lane runs jobs is `flat`.
 *  Injected readers only — never writes, never touches the network, and missing
 *  or ambiguous evidence is never `moving` or `flat`. */
import {
  type LaneState,
  type LaneTruthReaders,
  type MeterSample,
} from './fleet-lane-truth.js';
import { homedir } from 'node:os';
import { defaultMeterDropReaders } from '../core/fleet/meter-drop-readers.js';
import { POOLS_STALE_AFTER_MINUTES } from '../core/fleet/pools-view.js';

/** Plain words. `flat` is the incident: workers ran 60+ minutes and the meter did not move.
 *  `watching` is flat so far but not yet provable (under 60 minutes, or no worker count). */
export type MeterDropVerdict = 'moving' | 'flat' | 'idle' | 'watching' | 'no meter' | 'stale';

/** A flat meter must have been observed this long, with work running, to be an incident. */
export const METER_FLAT_MINUTES = 60;
/** Same bound `phm pools` uses before a reading counts as unknown. */
export const METER_STALE_MS = POOLS_STALE_AFTER_MINUTES * 60_000;

export interface MeterDropWindow {
  window: string;
  /** Usable observations seen; two distinct timed samples are required to prove a span. */
  samples: number;
  firstUsedPercent: number | null;
  lastUsedPercent: number | null;
  /** last − first used-percent; null when the window cannot prove a comparable span. */
  delta: number | null;
  observedMinutes: number | null;
  firstSampledAt: string | null;
  lastSampledAt: string | null;
  /** Latest usable sample is absent or older than METER_STALE_MS. */
  stale: boolean;
}

export interface MeterDropProvider {
  provider: string;
  /** Proven running jobs on the matching lane(s); null when no lane read a count. */
  running: number | null;
  verdict: MeterDropVerdict;
  windows: MeterDropWindow[];
}

export interface MeterDropReport {
  schema: 'fleet.meter-drop.v1';
  generatedAt: string;
  /** Providers whose meter stayed flat for an hour while running jobs were proven. */
  incidents: number;
  providers: MeterDropProvider[];
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,40}$/;
const usage = 'ashlr fleet meter-drop [--json] — read-only; flat meter + running jobs = incident';
const WINDOW_ID = /^[a-z0-9][a-z0-9:._-]{0,39}$/;
const providerName = (v: unknown): string => typeof v === 'string' && PROVIDER_ID.test(v) ? v : 'unknown';
const windowName = (v: unknown): string => typeof v === 'string' && WINDOW_ID.test(v) ? v : 'other';
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const ms = (v: unknown): number => typeof v === 'string' ? Date.parse(v) : NaN;

/** A sample that can stand as evidence: sane percent and a timestamp not in the future. */
const usable = (s: MeterSample, now: number): s is MeterSample & { usedPercent: number } =>
  typeof s.usedPercent === 'number' && Number.isFinite(s.usedPercent) &&
  s.usedPercent >= 0 && s.usedPercent <= 100 &&
  Number.isFinite(ms(s.sampledAt)) && ms(s.sampledAt) <= now;

function assessProvider(provider: string, samples: readonly MeterSample[], lanes: readonly LaneState[], now: number): MeterDropProvider {
  const grouped = new Map<string, { usableCount: number; byMs: Map<number, number>; conflict: boolean }>();
  for (const sample of samples) {
    const key = windowName(sample.window);
    const window = grouped.get(key) ?? { usableCount: 0, byMs: new Map<number, number>(), conflict: false };
    grouped.set(key, window);
    if (!usable(sample, now)) continue;
    window.usableCount++;
    const prior = window.byMs.get(ms(sample.sampledAt));
    // Two readings that share a timestamp but disagree preserve the ambiguity.
    if (prior !== undefined && prior !== sample.usedPercent) window.conflict = true;
    else window.byMs.set(ms(sample.sampledAt), sample.usedPercent);
  }

  let moved = false;
  let proven = true;
  let stale = false;
  let seen = false;
  const windows: MeterDropWindow[] = [];
  for (const [key, window] of grouped) {
    const obs = [...window.byMs.entries()].sort((a, b) => a[0] - b[0]);
    const first = obs[0] ?? null;
    const last = obs.at(-1) ?? null;
    const isStale = !last || now - last[0] > METER_STALE_MS;
    const comparable = !window.conflict && obs.length >= 2;
    const span = comparable ? Math.round((last![0] - first![0]) / 60_000) : null;
    if (last) seen = true;
    if (last && isStale) stale = true;
    if (comparable && last![1] !== first![1]) moved = true;
    if (span === null || span < METER_FLAT_MINUTES) proven = false;
    windows.push({
      window: key,
      samples: window.usableCount,
      firstUsedPercent: first?.[1] ?? null,
      lastUsedPercent: last?.[1] ?? null,
      delta: comparable ? last![1] - first![1] : null,
      observedMinutes: span,
      firstSampledAt: first ? new Date(first[0]).toISOString() : null,
      lastSampledAt: last ? new Date(last[0]).toISOString() : null,
      stale: isStale,
    });
  }

  const matched = lanes.filter(lane => providerName(lane.lane) === provider);
  const runnings = matched.map(lane => count(lane.running));
  const known = runnings.filter((r): r is number => r !== null);
  const running = known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
  const complete = matched.length > 0 && known.length === matched.length;

  let verdict: MeterDropVerdict;
  if (!seen) verdict = 'no meter';
  else if (stale) verdict = 'stale';
  else if (moved) verdict = 'moving';
  else if (running === 0 && complete) verdict = 'idle';
  else if (running !== null && running > 0 && proven) verdict = 'flat';
  else verdict = 'watching';
  return { provider, running, verdict, windows };
}

export async function readMeterDrop(readers: LaneTruthReaders, now = Date.now()): Promise<MeterDropReport> {
  const [lanes, samples] = await Promise.all([
    readers.lanes().catch(() => [] as LaneState[]),
    readers.meters().catch(() => [] as MeterSample[]),
  ]);
  const providers = new Map<string, MeterSample[]>();
  for (const sample of samples) {
    const name = providerName(sample.provider);
    const list = providers.get(name) ?? [];
    list.push(sample);
    providers.set(name, list);
  }
  // A lane with no meter evidence still earns a `no meter` row.
  for (const lane of lanes) {
    const name = providerName(lane.lane);
    if (!providers.has(name)) providers.set(name, []);
  }
  const rank: Record<MeterDropVerdict, number> = { flat: 0, stale: 1, 'no meter': 2, watching: 3, idle: 4, moving: 5 };
  const rows = [...providers.entries()]
    .map(([name, list]) => assessProvider(name, list, lanes, now))
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.provider.localeCompare(b.provider));
  return {
    schema: 'fleet.meter-drop.v1',
    generatedAt: new Date(now).toISOString(),
    incidents: rows.filter(row => row.verdict === 'flat').length,
    providers: rows,
  };
}

export async function cmdFleetMeterDrop(args: string[], readers?: LaneTruthReaders, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) return 2;
  try {
    const report = await readMeterDrop(readers ?? defaultMeterDropReaders(homedir(), now), now);
    console.log(args.includes('--json') ? JSON.stringify(report) : report.providers.map(row => `${row.provider}: ${row.verdict}`).join('\n'));
    return 0;
  } catch { console.error('fleet meter-drop: meter evidence unavailable'); return 1; }
}
