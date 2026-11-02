/** Pure, read-only projection of the bridge's memstat.json and .memguard2.json.
 *  Every field degrades independently to null; an absent file is unknown, never zero. */
export const FLEET_MEMORY_STALE_MS = 5 * 60 * 1000;

export interface FleetMemorySampleView {
  free_pct: number | null;
  swap_gb: number | null;
  swapouts_per_min: number | null;
  disk_gb: number | null;
  /** Sample timestamp normalized to ISO; null when the file's ts is unusable. */
  sampled_at: string | null;
  /** now − sampled_at in milliseconds; negative when the sample is ahead of the clock. */
  age_ms: number | null;
  /** true once age_ms exceeds FLEET_MEMORY_STALE_MS; null when age is unknown. */
  stale: boolean | null;
}

export interface FleetMemoryGuardView {
  level: string | number | null;
  /** Stopped job ids in the file's order; null when the file does not report them. */
  stopped: string[] | null;
}

export interface FleetMemoryView {
  schema: 'fleet.memory.v1';
  generatedAt: string;
  sample: FleetMemorySampleView;
  memguard: FleetMemoryGuardView;
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const percent = (v: unknown): number | null => nonnegative(v) && v <= 100 ? v : null;
const gb = (v: unknown): number | null => nonnegative(v) ? v : null;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

const level = (v: unknown): string | number | null =>
  (typeof v === 'number' && Number.isFinite(v)) || identifier(v) ? v : null;

const sampleTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

/** Unknown inputs yield unknown fields; a partial object keeps the fields that validate. */
export function memoryView(memstat: unknown, memguard: unknown, now = Date.now()): FleetMemoryView {
  if (!Number.isFinite(now)) throw new Error('Invalid reporting time');
  const stat = object(memstat) ? memstat : {};
  const sampledMs = sampleTime(stat.ts);
  const age = sampledMs === null ? null : now - sampledMs;
  const guard = object(memguard) ? memguard : {};
  const stoppedRaw = guard.stopped ?? guard.stopped_jobs;
  return {
    schema: 'fleet.memory.v1',
    generatedAt: new Date(now).toISOString(),
    sample: {
      free_pct: percent(stat.free_pct),
      swap_gb: gb(stat.swap_gb),
      swapouts_per_min: gb(stat.swapouts_per_min),
      disk_gb: gb(stat.disk_gb),
      sampled_at: sampledMs === null ? null : new Date(sampledMs).toISOString(),
      age_ms: age,
      stale: age === null ? null : age > FLEET_MEMORY_STALE_MS,
    },
    memguard: {
      level: level(guard.level),
      stopped: Array.isArray(stoppedRaw) ? stoppedRaw.filter(identifier) : null,
    },
  };
}
