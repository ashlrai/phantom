/** Read-only meter-drop report: each provider's usage meter must visibly move
 *  between its two timed samples or the provider is an incident candidate. A
 *  meter flat for an observed hour while its lane runs jobs is `flat_with_work`.
 *  Injected readers only — never writes, never touches the network, and missing
 *  or ambiguous evidence is `unknown`, never `moving`. */
import {
  defaultLaneTruthReaders,
  LANE_TRUTH_MAX_AGE_MS,
  type LaneState,
  type LaneTruthReaders,
  type MeterSample,
} from './fleet-lane-truth.js';

export type MeterDropVerdict = 'moving' | 'flat_with_work' | 'flat_idle' | 'unknown';

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
  /** Latest usable sample is absent or outside the freshness bound. */
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
  /** Providers whose meter stayed flat while running jobs were proven. */
  incidents: number;
  providers: MeterDropProvider[];
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,40}$/;
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

  let resolved = grouped.size > 0;
  let moved = false;
  const windows: MeterDropWindow[] = [];
  for (const [key, window] of grouped) {
    const obs = [...window.byMs.entries()].sort((a, b) => a[0] - b[0]);
    const first = obs[0] ?? null;
    const last = obs.at(-1) ?? null;
    const stale = !last || now - last[0] > LANE_TRUTH_MAX_AGE_MS;
    const comparable = !window.conflict && obs.length >= 2;
    if (window.conflict || obs.length < 2 || stale) resolved = false;
    else if (last![1] !== first![1]) moved = true;
    windows.push({
      window: key,
      samples: window.usableCount,
      firstUsedPercent: first?.[1] ?? null,
      lastUsedPercent: last?.[1] ?? null,
      delta: comparable ? last![1] - first![1] : null,
      observedMinutes: comparable ? Math.round((last![0] - first![0]) / 60_000) : null,
      firstSampledAt: first ? new Date(first[0]).toISOString() : null,
      lastSampledAt: last ? new Date(last[0]).toISOString() : null,
      stale,
    });
  }

  const matched = lanes.filter(lane => providerName(lane.lane) === provider);
  const runnings = matched.map(lane => count(lane.running));
  const known = runnings.filter((r): r is number => r !== null);
  const running = known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
  const complete = matched.length > 0 && known.length === matched.length;

  let verdict: MeterDropVerdict = 'unknown';
  if (resolved) {
    if (moved) verdict = 'moving';
    else if (running !== null && running > 0) verdict = 'flat_with_work';
    else if (running === 0 && complete) verdict = 'flat_idle';
  }
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
  // A lane with running jobs but no meter evidence still earns an `unknown` row.
  for (const lane of lanes) {
    const name = providerName(lane.lane);
    if (!providers.has(name)) providers.set(name, []);
  }
  const rank: Record<MeterDropVerdict, number> = { flat_with_work: 0, unknown: 1, flat_idle: 2, moving: 3 };
  const rows = [...providers.entries()]
    .map(([name, list]) => assessProvider(name, list, lanes, now))
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.provider.localeCompare(b.provider));
  return {
    schema: 'fleet.meter-drop.v1',
    generatedAt: new Date(now).toISOString(),
    incidents: rows.filter(row => row.verdict === 'flat_with_work').length,
    providers: rows,
  };
}

export async function cmdFleetMeterDrop(args: string[], readers = defaultLaneTruthReaders(), now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet meter-drop [--json] — read-only; flat meter + running jobs = incident');
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) return 2;
  try {
    const report = await readMeterDrop(readers, now);
    console.log(args.includes('--json') ? JSON.stringify(report) : report.providers.map(row => `${row.provider}: ${row.verdict}`).join('\n'));
    return 0;
  } catch { console.error('fleet meter-drop: meter evidence unavailable'); return 1; }
}
