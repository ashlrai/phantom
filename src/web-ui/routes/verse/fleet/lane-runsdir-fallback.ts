/**
 * routes/verse/fleet/lane-runsdir-fallback.ts — when the standing tick's lane
 * observation is stale the live API reports every lane as slots 0 with the
 * STALE_STANDING_LANES reason, which the chips print as "capacity unknown".
 * dispatchd's own figures (~/.ashlr-runs/queue/status.json, served through
 * GET /api/verse/fleet/runs) are an independent observation of the same Mac
 * fleet, so a stale chip falls back to them: "7 of 10 · 712 queued", or
 * "held" while the pool is held.
 *
 * Pure and framework-free; a null result keeps the chip's existing
 * unknown-capacity text.
 */
import type { FleetEngine, FleetLaneState } from '../../../../core/fleet/fleet-types.js';
import type { FleetRunsLane } from '../../../../core/fleet/runs-dir-state.js';
import { formatRelative } from '../autonomy/format.js';

/** The capReason the live API stamps on every lane when the standing tick is older than 10 minutes. */
export const STALE_STANDING_LANES = 'No standing tick has reported lanes in the last 10 minutes.';

/** A runs read older than this cannot stand in for the missing standing tick. */
export const RUNS_READ_MAX_AGE_MS = 15 * 60_000;

/**
 * The dispatchd lane (queue/status.json id, see LANES in
 * contrib/mac/dispatchd.py) a Fleet lane reads through — fleet ids are the
 * LANE_LABEL / LANE_ENGINE keys in live-model.ts. `codex` maps to codex-cmp,
 * the general codex pool: codex-personal serves only LAND/FIXUP/DRAIN/DAILYFIX
 * maintenance lines (drive/pool-routing.ts), and claude-api is API-credit
 * capacity with no lane chip of its own. dispatchd has no grok lane today; the
 * id is named so a future one matches, and until then the lookup just misses.
 */
const DISPATCHD_LANE: Readonly<Record<FleetEngine, string>> = {
  local: 'codex-local',
  'grok-cli': 'grok',
  'claude-cli': 'claude',
  codex: 'codex-cmp',
  'devin-cli': 'devin',
};

/** The lane figures the fallback reads — the wire projection drops floor/ceiling, so this is the structural subset. */
export type FallbackRunsLane = Pick<FleetRunsLane, 'lane' | 'running' | 'target' | 'queued' | 'held'>;

/**
 * The chip's dispatchd fallback, or null to keep today's text. Applies only to
 * the stale-standing case; needs a lane the runs read reported and a read no
 * older than 15 minutes (`readAt` is dispatchd's last tick — the figures' own
 * instant, so a dead dispatcher keeps answering "unknown" rather than a lie).
 */
export function laneFallback(lane: FleetLaneState, runs: readonly FallbackRunsLane[] | null, readAt: string | null, now: number): { slots: string; note: string } | null {
  if (lane.slots !== 0 || lane.capReason !== STALE_STANDING_LANES) return null;
  const match = runs?.find((r) => r.lane === DISPATCHD_LANE[lane.lane]);
  if (!match) return null;
  const readMs = readAt === null ? NaN : Date.parse(readAt);
  if (!Number.isFinite(readMs) || now - readMs > RUNS_READ_MAX_AGE_MS) return null;
  const slots = match.held ? 'held' : `${match.running} of ${match.target}${match.queued > 0 ? ` · ${match.queued} queued` : ''}`;
  return { slots, note: `from dispatchd, read ${formatRelative(readAt, now)}` };
}
