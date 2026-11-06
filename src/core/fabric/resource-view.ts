/** Shared, derived resource facts. Percentages are percentage points, never fractions. */
export const RESOURCE_SCHEMA = 'resource.v1' as const;
export const RESOURCE_POOLS = ['grok-ultra', 'codex-cmp', 'codex-personal', 'claude-max', 'terra', 'devin'] as const;
export type ResourcePool = typeof RESOURCE_POOLS[number];
export type ResourceStatus = 'green' | 'amber' | 'red' | 'unknown';
export const RESOURCE_MAX_AGE_MS = 35 * 60_000;
export const MACHINE_MAX_AGE_MS = 60_000;

export interface PoolResourceView {
  pool: ResourcePool;
  pctUsed: number | null;
  /** Percentage points consumed per hour. Null until comparable observations exist. */
  burnRatePerHour: number | null;
  resetAt: string | null;
  projectedExhaustionAt: string | null;
  /** Observed burn divided by remaining quota / remaining hours to this pool's reset. */
  paceRatio: number | null;
  status: ResourceStatus;
  source: string | null;
  fetchedAt: string | null;
}
export interface MachineResourceView {
  memFreePct: number | null;
  swapUsedPct: number | null;
  diskFreePct: number | null;
  admission: 'open' | 'held' | 'unknown';
  source: 'performance-telemetry' | null;
  fetchedAt: string | null;
}
export interface ResourceView {
  schema: typeof RESOURCE_SCHEMA;
  generatedAt: string;
  pools: PoolResourceView[];
  machine: MachineResourceView;
  localModels: { status: 'known' | 'unknown'; count: number | null; fetchedAt: string | null };
}

export function resourceObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function percent(value: unknown): value is number { return nonnegative(value) && value <= 100; }
function instant(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function fresh(value: unknown, nowMs: number, maxAge: number): value is string {
  return instant(value) && Date.parse(value) <= nowMs && nowMs - Date.parse(value) < maxAge;
}
function ratio(part: unknown, total: unknown): number | null {
  return nonnegative(part) && nonnegative(total) && total > 0 && part <= total ? part / total * 100 : null;
}

/** No reset extrapolation: samples crossing a reset or a counter decrease need a new baseline. */
export function projectPoolResource(pool: ResourcePool, value: unknown, previous: unknown, nowMs: number): PoolResourceView {
  const row = resourceObject(value), before = resourceObject(previous);
  const expectedSource = pool === 'devin' ? 'devin-api-v3-org-cycle' : pool === 'grok-ultra' ? 'grok-reader' : `${pool}-reader`;
  const source = row.source === expectedSource ? expectedSource : null;
  const fetchedAt = instant(row.fetchedAt) ? row.fetchedAt : null;
  const resetAt = instant(row.resetAt) ? row.resetAt : null;
  const out: PoolResourceView = { pool, pctUsed: null, burnRatePerHour: null, resetAt,
    projectedExhaustionAt: null, paceRatio: null, status: 'unknown', source, fetchedAt };
  const maxAge = pool === 'devin' ? 5 * 60_000 : RESOURCE_MAX_AGE_MS;
  if (row.pool !== pool || !source || !fresh(fetchedAt, nowMs, maxAge) ||
      !percent(row.pctUsed) || resetAt !== null && Date.parse(resetAt) <= nowMs) return out;
  out.pctUsed = row.pctUsed;
  let burn = nonnegative(row.burnRatePctPerHour) ? row.burnRatePctPerHour : null;
  if (burn === null && before.pool === pool && before.source === source && resetAt !== null && before.resetAt === resetAt &&
      percent(before.pctUsed) && row.pctUsed >= before.pctUsed && fresh(before.fetchedAt, nowMs, maxAge) &&
      Date.parse(before.fetchedAt) < Date.parse(fetchedAt)) {
    burn = (row.pctUsed - before.pctUsed) * 3_600_000 / (Date.parse(fetchedAt) - Date.parse(before.fetchedAt));
  }
  if (burn !== null && !Number.isFinite(burn)) burn = null;
  out.burnRatePerHour = burn;
  if (row.pctUsed === 100) {
    out.projectedExhaustionAt = fetchedAt;
    out.status = 'red';
    return out;
  }
  if (burn === null || resetAt === null) return out;
  const hoursToReset = (Date.parse(resetAt) - Date.parse(fetchedAt)) / 3_600_000;
  out.paceRatio = burn * hoursToReset / (100 - row.pctUsed);
  if (!Number.isFinite(out.paceRatio)) { out.paceRatio = null; return out; }
  if (burn > 0) {
    const exhaustion = Date.parse(fetchedAt) + (100 - row.pctUsed) / burn * 3_600_000;
    if (Number.isFinite(exhaustion) && exhaustion <= 8.64e15) out.projectedExhaustionAt = new Date(exhaustion).toISOString();
  }
  out.status = out.projectedExhaustionAt !== null && Date.parse(out.projectedExhaustionAt) <= nowMs ? 'red'
    : out.paceRatio > 1 ? 'amber' : 'green';
  return out;
}

/** Performance owns admission. Missing swap capacity never becomes a fabricated percentage. */
export function projectMachineResource(value: unknown, nowMs: number): MachineResourceView {
  const row = resourceObject(value);
  const out: MachineResourceView = { memFreePct: null, swapUsedPct: null, diskFreePct: null,
    admission: 'unknown', source: null, fetchedAt: null };
  if (row.schemaVersion !== 1 || !nonnegative(row.sampledAtMs) || row.sampledAtMs > nowMs || nowMs - row.sampledAtMs >= MACHINE_MAX_AGE_MS) return out;
  out.source = 'performance-telemetry'; out.fetchedAt = new Date(row.sampledAtMs).toISOString();
  const ram = resourceObject(row.ram), swap = resourceObject(row.swap);
  out.memFreePct = ratio(ram.freeBytes, ram.totalBytes);
  out.swapUsedPct = ratio(swap.usedBytes, swap.totalBytes);
  const disks = Array.isArray(row.disks) ? row.disks.map(resourceObject) : [];
  const root = disks.find(disk => disk.volume === '/');
  if (root) out.diskFreePct = ratio(root.freeBytes, root.totalBytes);
  // Consume Performance's headroom and veto, without recreating its admission policy.
  if (row.memguardPaused === true || resourceObject(row.memoryPressure).level === 'critical') out.admission = 'held';
  else if (row.memguardPaused === false && row.queueState === 'known' && Number.isSafeInteger(row.headroom) && Number(row.headroom) >= 0 &&
    out.memFreePct !== null && nonnegative(swap.growthBytesPerSecond) && Array.isArray(row.jobs) &&
    row.jobs.every(job => nonnegative(resourceObject(job).rssBytes))) out.admission = Number(row.headroom) > 0 ? 'open' : 'held';
  return out;
}

/** Read only allowlisted facts from sibling namespaces; arbitrary fleet data never reaches the UI. */
export function buildResourceView(value: unknown, nowMs = Date.now(), previousValue?: unknown): ResourceView {
  if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > 8.64e15) throw new RangeError('Invalid resource clock');
  const fleet = resourceObject(value), resources = resourceObject(fleet.resources), readings = resourceObject(fleet.readings);
  const previous = resourceObject(previousValue), oldResources = resourceObject(previous.resources), oldReadings = resourceObject(previous.readings);
  const saved = resourceObject(resources.view);
  const savedPools = saved.schema === RESOURCE_SCHEMA && Array.isArray(saved.pools) ? saved.pools.map(resourceObject) : [];
  const models = resourceObject(resources.models);
  const modelFresh = fresh(models.measuredAt, nowMs, RESOURCE_MAX_AGE_MS) && models.schemaVersion === 1 && Array.isArray(models.models);
  return { schema: RESOURCE_SCHEMA, generatedAt: new Date(nowMs).toISOString(),
    pools: RESOURCE_POOLS.map(pool => projectPoolResource(pool, pool === 'devin' ? resources.devin : readings[pool],
      (pool === 'devin' ? oldResources.devin : oldReadings[pool]) ?? savedPools.find(row => row.pool === pool), nowMs)),
    machine: projectMachineResource(resources.machine, nowMs),
    localModels: { status: modelFresh ? 'known' : 'unknown', count: modelFresh ? (models.models as unknown[]).length : null,
      fetchedAt: instant(models.measuredAt) ? models.measuredAt : null } };
}

/** Structural subset of #938's PacePlan. No solver or horizon policy is duplicated here. */
export interface ResourcePacePlan { allowance: number; periods: readonly { startMs: number; endMs: number }[] }
export interface ResourcePacingDecision { pool: ResourcePool; action: 'open' | 'throttle' | 'hold' | 'unknown'; slots: number | null }

/** Consume signal-slots' admitted ceilings and #938's current plans; never create admission. */
export function paceResourceSlots(view: ResourceView, admittedSlots: Readonly<Partial<Record<ResourcePool, number>>>,
  plans: Readonly<Partial<Record<ResourcePool, ResourcePacePlan>>>, nowMs = Date.now()): ResourcePacingDecision[] {
  return view.pools.map(pool => {
    const ceiling = admittedSlots[pool.pool], plan = plans[pool.pool], first = plan?.periods[0];
    const result: ResourcePacingDecision = { pool: pool.pool, action: 'unknown', slots: null };
    if (!Number.isSafeInteger(nowMs)) return result;
    if (ceiling === 0) return { ...result, action: 'hold', slots: 0 };
    if (!fresh(view.machine.fetchedAt, nowMs, MACHINE_MAX_AGE_MS)) return result;
    if (view.machine.admission === 'held') return { ...result, action: 'hold', slots: 0 };
    if (view.machine.admission !== 'open' || !fresh(view.machine.fetchedAt, nowMs, MACHINE_MAX_AGE_MS) ||
      !fresh(pool.fetchedAt, nowMs, pool.pool === 'devin' ? 300_000 : RESOURCE_MAX_AGE_MS) ||
      pool.resetAt === null || Date.parse(pool.resetAt) <= nowMs || pool.status === 'unknown' ||
      !Number.isSafeInteger(ceiling) || ceiling! < 0 || !plan || !nonnegative(plan.allowance) || plan.allowance > 1 ||
      !first || !Number.isSafeInteger(first.startMs) || !Number.isSafeInteger(first.endMs) ||
      first.startMs > nowMs || first.endMs <= nowMs || first.endMs > Date.parse(pool.resetAt)) return result;
    if (pool.status === 'red' || pool.projectedExhaustionAt !== null && Date.parse(pool.projectedExhaustionAt) <= nowMs) {
      return { ...result, action: 'hold', slots: 0 };
    }
    if (plan.allowance === 0) return { ...result, action: 'hold', slots: 0 };
    if (pool.paceRatio === null) return result;
    const rate = plan.allowance * 100 * 3_600_000 / (first.endMs - first.startMs);
    const burn = pool.burnRatePerHour;
    if (burn === null || !Number.isFinite(rate) || rate <= 0) return result;
    // Reopen only within the upstream admitted ceiling and the pacer's current allowance.
    const scale = Math.min(1, pool.paceRatio > 1 ? 1 / pool.paceRatio : 1, burn > 0 ? rate / burn : 1);
    const slots = Math.floor(ceiling! * scale);
    return { pool: pool.pool, action: slots < ceiling! ? 'throttle' : 'open', slots };
  });
}
