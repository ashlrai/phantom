/** Read-only leader placement. Reuses the dispatcher and Models readers; never probes a provider. */
import type { FleetRunsDirState } from './runs-dir-state.js';
import { resolveLaneModel, type LaneModelSnapshot } from './lane-models.js';
import { selectVerifiedModel, type VerifiedModelRegistryEntry } from './model-verify.js';
import { QUOTA_EVIDENCE_MAX_AGE_MS } from './resource-reset-evidence.js';

export interface LeaderLaneSeat {
  lane: string; model: string|null; confirmed: boolean;
  health: 'ok'|'degraded'|'down'|'unknown';
  headroomPct: number|null; resetAt: string|null; recentPassMs: number|null;
  eligible: boolean; reason: string|null;
}
export interface LeaderSeatReport {
  schema: 'leader.seat.v1'; version: 1; generatedAt: string;
  current: { lane: string|null; model: string|null; lastSuccessAt: string|null };
  fallbacks: LeaderLaneSeat[]; pick: LeaderLaneSeat|null; reason: string|null;
}
const healthRank = { ok: 0, degraded: 1, down: 2, unknown: 3 };
/** Lexicographic score: health, descending included headroom, ascending recent pass ms, lane ID.
 * Unknown numbers sort last. No provider preference or clock/I/O inside the comparator. */
export function compareLeaderSeats(a: LeaderLaneSeat, b: LeaderLaneSeat): number {
  return healthRank[a.health] - healthRank[b.health] || (b.headroomPct ?? -1) - (a.headroomPct ?? -1)
    || (a.recentPassMs ?? Number.MAX_VALUE) - (b.recentPassMs ?? Number.MAX_VALUE)
    || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);
}
export function buildLeaderSeat(runs: FleetRunsDirState|null, models: LaneModelSnapshot|null,
  registry: readonly VerifiedModelRegistryEntry[]|null, now: number): LeaderSeatReport {
  const fresh = (at: string|null|undefined, max: number) => !!at && now >= Date.parse(at) && now - Date.parse(at) <= max;
  const statusFresh = runs?.sources.status === 'healthy' && fresh(runs.lastTick, QUOTA_EVIDENCE_MAX_AGE_MS);
  const choices = new Map(models?.lanes.flatMap(row => (row.tiers ?? []).flatMap(tier => tier.model ? [[`${row.lane}.${tier.tier}`, tier.model] as const] : [])));
  const seats = (runs?.lanes ?? []).map((lane): LeaderLaneSeat => {
    const data = lane.seat, model = resolveLaneModel(choices, lane.lane, 'frontier')?.model ?? null;
    const confirmed = model !== null && selectVerifiedModel([model], registry ?? []).model === model;
    const health = statusFresh ? data?.health ?? (lane.healthy === true ? 'ok' : lane.healthy === false ? 'down' : 'unknown') : 'unknown';
    const quotaFresh = statusFresh && fresh(data?.observedAt, QUOTA_EVIDENCE_MAX_AGE_MS) && !!data?.resetAt && Date.parse(data.resetAt) > now;
    const headroomPct = quotaFresh && data?.usedPct != null && Number.isFinite(data.usedPct) && data.usedPct >= 0 ? Math.max(0, 100 - data.usedPct) : null;
    const recentPassMs = statusFresh && fresh(data?.passAt, 12 * 3_600_000) ? data?.passMs ?? null : null;
    const reason = !confirmed ? 'Model is not confirmed in the registry.' : runs?.paused ? 'Dispatch is paused.'
      : lane.held ? 'Lane is held.' : health === 'unknown' ? 'Lane health is unknown.' : health === 'down' ? 'Lane is down.'
      : headroomPct === 0 ? 'Included usage is exhausted.' : null;
    return { lane: lane.lane, model, confirmed, health, headroomPct, resetAt: data?.resetAt ?? null,
      recentPassMs, eligible: reason === null, reason };
  }).sort(compareLeaderSeats);
  const current = { lane: statusFresh ? runs?.leader?.lane ?? null : null, model: statusFresh ? runs?.leader?.model ?? null : null,
    lastSuccessAt: runs?.leader?.lastSuccessAt ?? null };
  const pick = seats.find(seat => seat.eligible) ?? null;
  return { schema: 'leader.seat.v1', version: 1, generatedAt: new Date(now).toISOString(), current,
    fallbacks: seats.filter(seat => seat.lane !== current.lane), pick,
    reason: pick ? null : seats.every(seat => seat.health === 'unknown') ? 'No seat: lane health is unknown.' : 'No eligible confirmed leader seat.' };
}
export interface LeaderSeatReaders {
  status: () => Promise<FleetRunsDirState|null>;
  models: () => Promise<LaneModelSnapshot|null>;
  registry: () => Promise<VerifiedModelRegistryEntry[]|null>;
  now: () => number;
}
export async function readLeaderSeat(readers: Partial<LeaderSeatReaders> = {}): Promise<LeaderSeatReport> {
  const now = (readers.now ?? Date.now)();
  const status = readers.status ?? (async () => (await import('./runs-dir-state.js')).readFleetRunsDirState({ now: () => now }));
  const models = readers.models ?? (async () => (await import('./lane-models.js')).getLaneModelSnapshot());
  const registry = readers.registry ?? (async () => (await import('./model-verify.js')).loadVerifiedRegistry({ now: () => now }));
  const [s, m, r] = await Promise.allSettled([status(), models(), registry()]);
  return buildLeaderSeat(s.status === 'fulfilled' ? s.value : null, m.status === 'fulfilled' ? m.value : null, r.status === 'fulfilled' ? r.value : null, now);
}
export function leaderSeatText(report: LeaderSeatReport, pickOnly = false): string {
  const line = (seat: LeaderLaneSeat) => `${seat.lane} · ${seat.model ?? 'model unknown'} · ${seat.health} · headroom ${seat.headroomPct === null ? 'unknown' : `${seat.headroomPct}%`}${seat.reason ? ` · ${seat.reason}` : ''}`;
  const next = report.pick ? `Next seat: ${line(report.pick)}` : report.reason!;
  return pickOnly ? next : [`Leader seat: ${report.current.lane ?? 'unknown'} · ${report.current.model ?? 'model unknown'}`,
    `Last successful pass: ${report.current.lastSuccessAt ?? 'unknown'}`, next, ...report.fallbacks.map(seat => `Fallback: ${line(seat)}`)].join('\n');
}
