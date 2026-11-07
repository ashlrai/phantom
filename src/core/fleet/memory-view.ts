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
  /** Set only when the guard file declares a boolean omlx_down. */
  omlx_down?: boolean;
  /** Set only when the guard file declares a non-negative finite calm count. */
  calm?: number;
}

export interface FleetMemoryView {
  schema: 'fleet.memory.v1';
  generatedAt: string;
  sample: FleetMemorySampleView;
  memguard: FleetMemoryGuardView;
  resource_session?: ResourceSessionView;
}


/** Descriptive evidence only; never an admission decision. */
export interface ResourceSessionView {
  state: 'fresh' | 'stale' | 'future' | 'unknown';
  sampled_at: string | null;
  age_ms: number | null;
  pressure: 'normal' | 'warning' | 'critical' | 'not-applicable' | 'unknown';
  disk: { state: 'history' | 'stale' | 'unknown'; allocatedBytes: number | null; ageSeconds: number | null; provenance: string | null }; 
  censusState: 'known' | 'unknown';
  sessionsState: 'known' | 'unknown';
  sessions: ResourceSessionRow[];
}
export interface ResourceSessionRow {
  jobId: string;
  state: 'known' | 'unknown';
  processCount: number | null;
  rssBytes: number | null;
  cpuPercentOneCore: number | null;
  cpuPercentHost: number | null;
  swapBytes: null;
}
const RESOURCE_SESSION_MAX_AGE_MS = 30_000;

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const percent = (v: unknown): number | null => nonnegative(v) && v <= 100 ? v : null;
const gb = (v: unknown): number | null => nonnegative(v) ? v : null;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);

const level = (v: unknown): string | number | null =>
  (typeof v === 'number' && Number.isFinite(v)) || identifier(v) ? v : null;

// memstat.json writes epoch SECONDS; numbers at or above 1e11 (~Mar 1973 in ms,
// ~year 5138 in s) are already epoch milliseconds.
const EPOCH_SECONDS_MAX = 1e11;

const sampleTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < EPOCH_SECONDS_MAX ? v * 1000 : v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

// The guard writes stopped as an ARRAY of job ids or as a process-group→job-id
// map; a map whose values carry no valid id reports nothing, so it is unknown.
const stoppedIds = (v: unknown): string[] | null => {
  if (Array.isArray(v)) return v.filter(identifier);
  if (object(v)) {
    const ids = Object.values(v).filter(identifier);
    return ids.length ? ids : null;
  }
  return null;
};

/** Reject malformed or excessive input instead of rendering partial evidence as current. */
function resourceSessionView(input: unknown, now: number): ResourceSessionView {
  const unknown: ResourceSessionView = { state: 'unknown', sampled_at: null, age_ms: null, pressure: 'unknown', censusState: 'unknown', sessionsState: 'unknown', sessions: [], disk: { state: 'unknown', allocatedBytes: null, ageSeconds: null, provenance: null } };
  if (!object(input) || input.schemaVersion !== 1 || typeof input.observedAt !== 'string' ||
      !object(input.pressure) || !(typeof input.pressure.state === 'string' && ['normal', 'warning', 'critical', 'not-applicable', 'unknown'].includes(input.pressure.state)) ||
      !(input.censusState === 'known' || input.censusState === 'unknown') || !(input.sessionsState === 'known' || input.sessionsState === 'unknown') ||
      !Array.isArray(input.sessions) || input.sessions.length > 256 || (input.sessionsState === 'unknown' && input.sessions.length > 0)) return unknown;
  const timestamp = Date.parse(input.observedAt);
  if (!Number.isFinite(timestamp)) return unknown;
  const sessions: ResourceSessionRow[] = [];
  const seen = new Set<string>();
  for (const row of input.sessions) {
    if (!object(row) || !identifier(row.jobId) || seen.has(row.jobId) ||
        (row.state !== 'known' && row.state !== 'unknown') || row.swapBytes !== null) return unknown;
    const values = [row.processCount, row.rssBytes, row.cpuPercentOneCore, row.cpuPercentHost];
    if (values.some(value => value !== null && !nonnegative(value)) ||
        (row.processCount !== null && (!Number.isSafeInteger(row.processCount) || row.processCount === 0)) ||
        (row.state === 'unknown' && values.some(value => value !== null)) ||
        (row.state === 'known' && values.slice(0, 3).some(value => value === null))) return unknown;
    seen.add(row.jobId);
    sessions.push({ jobId: row.jobId, state: row.state, processCount: row.processCount as number | null,
      rssBytes: row.rssBytes as number | null, cpuPercentOneCore: row.cpuPercentOneCore as number | null,
      cpuPercentHost: row.cpuPercentHost as number | null, swapBytes: null });
  }
  const age = now - timestamp;
  const state = age < 0 ? 'future' : age > RESOURCE_SESSION_MAX_AGE_MS ? 'stale' : 'fresh';
  let disk = unknown.disk;
  if (age >= 0 && object(input.disk) && (input.disk.state === 'history' || input.disk.state === 'stale') &&
      nonnegative(input.disk.allocatedBytes) && nonnegative(input.disk.ageSeconds) &&
      typeof input.disk.provenance === 'string' && input.disk.provenance.length <= 256) {
    // Disk age is measured at publication; an older outer snapshot cannot reset it.
    const ageSeconds = input.disk.ageSeconds + age / 1000;
    disk = { state: state === 'stale' || ageSeconds > 900 ? 'stale' : input.disk.state,
      allocatedBytes: input.disk.allocatedBytes, ageSeconds, provenance: input.disk.provenance };
  }
  return { state, sampled_at: new Date(timestamp).toISOString(), age_ms: age,
    // Only a fresh observation can describe current pressure/process measurements.
    // Stale disk attribution remains explicitly historical; future evidence is invalid.
    pressure: state === 'fresh' ? input.pressure.state as ResourceSessionView['pressure'] : 'unknown',
    censusState: state === 'fresh' ? input.censusState as 'known' | 'unknown' : 'unknown',
    sessionsState: state === 'fresh' ? input.sessionsState as 'known' | 'unknown' : 'unknown',
    sessions: state === 'fresh' ? sessions : [], disk };
}

/** Unknown inputs yield unknown fields; a partial object keeps the fields that validate. */
export function memoryView(memstat: unknown, memguard: unknown, now = Date.now(), resourceSession?: unknown): FleetMemoryView {
  if (!Number.isFinite(now)) throw new Error('Invalid reporting time');
  const stat = object(memstat) ? memstat : {};
  const sampledMs = sampleTime(stat.ts);
  const age = sampledMs === null ? null : now - sampledMs;
  const guard = object(memguard) ? memguard : {};
  const stoppedRaw = guard.stopped ?? guard.stopped_jobs;
  return {
    ...(resourceSession === undefined ? {} : { resource_session: resourceSessionView(resourceSession, now) }),
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
      stopped: stoppedIds(stoppedRaw),
      ...(typeof guard.omlx_down === 'boolean' ? { omlx_down: guard.omlx_down } : {}),
      ...(nonnegative(guard.calm) ? { calm: guard.calm } : {}),
    },
  };
}
