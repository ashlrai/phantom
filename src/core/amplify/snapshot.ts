/** Pure metadata projection. Amplify proposes work; it never grants execution authority. */
export const AMPLIFY_OBJECTIVE = 'Maximize verified, durable engineering outcomes from available fleet capacity; use expiring included capacity before it is wasted, within existing security, spending and publication authority.';
export const MAX_AGE_MS = 30 * 60_000;
type Row = Record<string, unknown>;
export const record = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const num = (v: unknown, max = Infinity): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
export function stamp(v: unknown): string | null {
  const ms = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
export function fresh(at: unknown, now: number): boolean {
  const iso = stamp(at);
  return iso !== null && now >= Date.parse(iso) && now - Date.parse(iso) <= MAX_AGE_MS;
}
const name = (v: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(v) && !/token|secret|password/.test(v);
export interface AmplifyAction {
  kind: 'refresh-evidence' | 'check-heartbeat' | 'use-expiring-capacity' | 'review-saturation' | 'review-merge-flow';
  pool: string | null;
  priority: number;
  recommendation: string;
}
export interface AmplifyPool {
  pool: string; source: 'ledger' | 'overrides' | 'status'; observed_at: string | null;
  state: 'fresh' | 'stale' | 'unknown'; used_pct: number | null;
  reset_at: string | null; expires_at: string | null; seconds_to_reset: number | null; seconds_to_expiry: number | null;
  burn_pct_per_hour: number | null; projected_waste_pct: number | null;
  running: number | null; target: number | null; held: boolean | null; saturation: number | null;
}
export interface AmplifySnapshot {
  schema: 'amplify.status.v1'; at: string; objective: string; advisory: true;
  pools: AmplifyPool[]; vitals: { observed_at: string | null; load1: number | null; mem_free_pct: number | null; swap_gb: number | null; disk_free_gb: number | null };
  merge_velocity: { window_hours: 1; merged_per_hour: number | null };
  heartbeat: { stale: boolean; sources: { source: string; stale: boolean; ageMinutes: number | null }[] };
  actions: AmplifyAction[]; sources: Record<string, string>;
}
export function projectAmplify(input: { ledger: unknown; overrides: unknown; status: unknown; controller: unknown;
  heartbeat: AmplifySnapshot['heartbeat']; sources: Record<string, string> }, now: number): AmplifySnapshot {
  const ledger = record(input.ledger), status = record(input.status), overrides = record(input.overrides);
  const pools = record(ledger.pools), budgets = record(status.budget), lanes = record(status.lanes);
  const ids = new Set([...Object.keys(pools), ...Object.keys(budgets), ...Object.keys(lanes),
    ...Object.keys(overrides).filter(k => {
      const r = record(overrides[k]);
      return 'weekly_used_pct' in r || 'used_pct' in r || 'expires_at' in r;
    })]);
  const actions: AmplifyAction[] = [];
  const propose = (kind: AmplifyAction['kind'], pool: string | null, priority: number, recommendation: string) => actions.push({ kind, pool, priority, recommendation });
  const rows = [...ids].filter(name).sort().slice(0, 64).map((pool): AmplifyPool => {
    // Select one complete observation; never stitch usage/burn/reset across sources or reset windows.
    const candidates = [
      { source: 'overrides' as const, row: record(overrides[pool]), at: record(overrides[pool]).as_of },
      { source: 'ledger' as const, row: record(pools[pool]), at: record(pools[pool]).as_of ?? ledger.as_of ?? ledger.generated_at },
      { source: 'status' as const, row: record(budgets[pool]), at: record(budgets[pool]).observed_at ?? record(budgets[pool]).as_of },
    ].filter(c => Object.keys(c.row).length);
    const selected = candidates.find(c => fresh(c.at, now)) ?? candidates[0] ?? { source: 'status' as const, row: {}, at: null };
    const b = selected.row, at = stamp(selected.at), valid = fresh(at, now) && b.stale !== true;
    const reset = stamp(b.reset_at), expiry = stamp(b.expires_at);
    const until = (at: string | null) => at === null ? null : Math.max(0, (Date.parse(at) - now) / 1000);
    const deadline = Math.min(...[reset, expiry].filter((v): v is string => v !== null).map(Date.parse));
    const deadlinesValid = (b.reset_at == null || reset !== null) && (b.expires_at == null || expiry !== null);
    const active = valid && deadlinesValid && deadline > now;
    const used = active ? num(b.used_pct ?? b.weekly_used_pct, 100) : null;
    const burn = active ? num(b.burn_pct_per_hour) : null;
    const waste = used !== null && burn !== null && Number.isFinite(deadline)
      ? Math.max(0, 100 - used - burn * ((deadline - now) / 3_600_000)) : null;
    const lane = record(lanes[pool]), live = fresh(status.last_tick, now);
    const running = live ? num(lane.running) : null, target = live ? num(lane.target) : null;
    const held = live && typeof lane.held === 'boolean' ? lane.held : null;
    const saturation = running !== null && target !== null && target > 0 ? running / target : null;
    if (!active || used === null || burn === null || !Number.isFinite(deadline)) propose('refresh-evidence', pool, 80, 'Refresh recorded quota and burn evidence before capacity planning.');
    if (waste !== null && waste >= 10 && deadline - now <= 24 * 3_600_000)
      propose('use-expiring-capacity', pool, 90, held === false && running !== null && target !== null && running < target
        ? 'Prioritize eligible queued work on this pool before its reset or expiry, within existing limits.'
        : 'Review this pool’s holds, eligible work and existing limits before its capacity expires.');
    if (saturation !== null && saturation >= 1) propose('review-saturation', pool, 40, 'Review queued demand and completion bottlenecks against existing lane limits.');
    return { pool, source: selected.source, observed_at: at, state: active ? 'fresh' : at === null ? 'unknown' : 'stale',
      used_pct: used, reset_at: reset, expires_at: expiry, seconds_to_reset: until(reset), seconds_to_expiry: until(expiry),
      burn_pct_per_hour: burn, projected_waste_pct: waste, running, target, held, saturation };
  });
  if (!rows.length) propose('refresh-evidence', null, 80, 'Record fleet capacity metadata; no pool measurements are available.');
  if (input.heartbeat.stale) propose('check-heartbeat', null, 100, 'Investigate missing or stale fleet heartbeats before planning more work.');
  const controller = record(input.controller), signals = record(controller.signals), live = fresh(controller.ts, now);
  const merge = live ? num(signals.merge_rate_1h) : null;
  if (merge === 0 && rows.some(p => p.running !== null && p.running > 0))
    propose('review-merge-flow', null, 70, 'Inspect verification and merge bottlenecks: active work has no recorded merges in the last hour.');
  return { schema: 'amplify.status.v1', at: new Date(now).toISOString(), objective: AMPLIFY_OBJECTIVE, advisory: true,
    pools: rows, vitals: { observed_at: stamp(controller.ts), load1: live ? num(signals.load1) : null,
      mem_free_pct: live ? num(signals.mem_free_pct, 100) : null, swap_gb: live ? num(signals.swap_gb) : null,
      disk_free_gb: live ? num(signals.disk_free_gb) : null },
    merge_velocity: { window_hours: 1, merged_per_hour: merge }, heartbeat: input.heartbeat,
    actions: actions.sort((a, b) => b.priority - a.priority || (a.pool ?? '').localeCompare(b.pool ?? '')).slice(0, 20), sources: input.sources };
}
