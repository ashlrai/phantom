/**
 * fleet-usage.v1 wire type plus the pure view model behind the lane usage
 * panel. Everything is null-tolerant: a missing reading is "unknown", never
 * zero and never "unused capacity".
 */

export const FLEET_USAGE_SCHEMA = 'fleet-usage.v1';
/** Source readings older than this are flagged even if the feed forgot to. */
export const FLEET_USAGE_STALE_AFTER_SEC = 15 * 60;
export const FLEET_USAGE_LANES = ['claude', 'claude-api', 'codex-cmp', 'codex-personal', 'codex-local', 'devin', 'gemini', 'zai', 'omlx-local'] as const;

export interface FleetUsageLane {
  lane: string;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null;
  resetAt: string | null;
  burnPctPerHour: number | null;
  running: number | null;
  target: number | null;
  ceiling: number | null;
  queued: number | null;
  held: boolean;
  heldReason: string | null;
  /** Age of the upstream reading when the feed was generated. */
  sourceAgeSec: number | null;
  stale: boolean;
}
export interface FleetUsageV1 {
  schema: typeof FLEET_USAGE_SCHEMA;
  generatedAt: string;
  lanes: FleetUsageLane[];
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** Validates an untrusted payload. Throws on a wrong schema so a drifted feed is loud, not blank. */
export function parseFleetUsage(input: unknown): FleetUsageV1 {
  const raw = input as { schema?: unknown; generatedAt?: unknown; lanes?: unknown } | null;
  if (!raw || raw.schema !== FLEET_USAGE_SCHEMA || !Array.isArray(raw.lanes)) throw new Error(`Expected ${FLEET_USAGE_SCHEMA}`);
  const lanes: FleetUsageLane[] = [];
  for (const entry of raw.lanes as Record<string, unknown>[]) {
    const lane = str(entry?.lane);
    if (!lane) continue;
    const window = entry.window === 'weekly' || entry.window === 'credits' ? entry.window : 'none';
    const used = num(entry.usedPct);
    lanes.push({
      lane, window, usedPct: used === null ? null : Math.min(100, Math.max(0, used)), resetAt: str(entry.resetAt),
      burnPctPerHour: num(entry.burnPctPerHour), running: num(entry.running), target: num(entry.target),
      ceiling: num(entry.ceiling), queued: num(entry.queued), held: entry.held === true, heldReason: str(entry.heldReason),
      sourceAgeSec: num(entry.sourceAgeSec), stale: entry.stale === true,
    });
  }
  return { schema: FLEET_USAGE_SCHEMA, generatedAt: str(raw.generatedAt) ?? new Date(0).toISOString(), lanes };
}

export type WasteLevel = 'high' | 'medium' | 'low' | 'unknown';
export interface WasteRisk {
  level: WasteLevel;
  /** Projected unused percentage points at reset; null when it cannot be projected. */
  unusedPct: number | null;
  label: string;
}
export interface LaneCardModel {
  lane: FleetUsageLane;
  remainingPct: number | null;
  stale: boolean;
  risk: WasteRisk;
}

const pct = (value: number) => `${Math.round(value * 10) / 10}%`;

/**
 * Projected unused share at reset: remaining capacity minus what the observed
 * burn would consume before then. A held lane burns nothing, so all remaining
 * capacity is at risk. Lanes without a weekly window or reading are "unknown".
 */
export function wasteRisk(lane: FleetUsageLane, nowMs: number): WasteRisk {
  const resetMs = lane.resetAt === null ? NaN : Date.parse(lane.resetAt);
  if (lane.window === 'none' || lane.usedPct === null || !Number.isFinite(resetMs) || resetMs <= nowMs) {
    return { level: 'unknown', unusedPct: null, label: 'Waste risk unknown' };
  }
  if (lane.burnPctPerHour === null && !lane.held) return { level: 'unknown', unusedPct: null, label: 'Waste risk unknown (burn not reported)' };
  const burn = lane.held ? 0 : lane.burnPctPerHour ?? 0;
  const unusedPct = Math.max(0, Math.min(100, 100 - lane.usedPct - burn * ((resetMs - nowMs) / 3_600_000)));
  const level: WasteLevel = unusedPct >= 50 ? 'high' : unusedPct >= 15 ? 'medium' : 'low';
  return { level, unusedPct, label: `${level === 'high' ? 'High waste: ' : ''}${pct(unusedPct)} unused at reset` };
}

const LEVEL_RANK: Record<WasteLevel, number> = { high: 0, medium: 1, low: 2, unknown: 3 };

/** Most at-risk first; unknown sorts after every known risk but ahead of nothing hidden. */
export function buildLaneCards(feed: FleetUsageV1, nowMs: number): LaneCardModel[] {
  const generatedMs = Date.parse(feed.generatedAt);
  // A feed that itself stopped updating makes every lane stale.
  const feedOld = Number.isFinite(generatedMs) && nowMs - generatedMs > FLEET_USAGE_STALE_AFTER_SEC * 1000;
  const cards = feed.lanes.map((lane): LaneCardModel => ({
    lane,
    remainingPct: lane.usedPct === null ? null : 100 - lane.usedPct,
    stale: lane.stale || (lane.sourceAgeSec ?? 0) > FLEET_USAGE_STALE_AFTER_SEC || feedOld,
    risk: wasteRisk(lane, nowMs),
  }));
  return cards.sort((a, b) => LEVEL_RANK[a.risk.level] - LEVEL_RANK[b.risk.level]
    || (b.risk.unusedPct ?? 0) - (a.risk.unusedPct ?? 0) || a.lane.lane.localeCompare(b.lane.lane));
}

export function formatCountdown(resetAt: string | null, nowMs: number): string {
  const ms = resetAt === null ? NaN : Date.parse(resetAt) - nowMs;
  if (!Number.isFinite(ms)) return 'Reset unknown';
  if (ms <= 0) return 'Resetting now';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400), hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
