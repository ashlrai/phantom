/**
 * resources/personal-lane-facts.ts — the codex-personal fleet lane's hover
 * detail for the resource bar's personal Codex row.
 *
 * The fleet-runs snapshot already reports per-lane running/target, queued work
 * and hold state; this projects the one lane Mason's own sessions run on into
 * the same line-per-fact shape every other bar row shows, so a held lane and
 * the work waiting behind it are visible without opening Ops. Pure and total:
 * malformed rows contribute nothing, so a partial snapshot can't break the bar.
 */
import { usageHeldReason } from '../../../components/notifications/deriveFleetRunsNotifications.js';

export interface PersonalLaneRow {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
  heldReason?: string | null;
}

/** Control characters never reach the tooltip; long reasons are capped. */
const clean = (reason: string): string =>
  reason.replace(/\p{Cc}/gu, '').trim().slice(0, 120);
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function personalLaneFacts(
  lanes: ReadonlyArray<PersonalLaneRow> | null | undefined,
  laneName = 'codex-personal',
): string[] {
  if (!Array.isArray(lanes)) return [];
  const lane = lanes.find(row => row !== null && typeof row === 'object' && typeof row.lane === 'string' && row.lane === laneName);
  if (!lane) return [];
  const queued = count(lane.queued);
  const lines = [`Lane ${lane.lane}: ${count(lane.running)}/${count(lane.target)} running${queued > 0 ? ` · ${queued} queued` : ''}`];
  if (lane.held === true) {
    const raw = typeof lane.heldReason === 'string' ? lane.heldReason : null;
    const reason = raw === null ? '' : clean(raw);
    lines.push(usageHeldReason(raw) ? `Held: usage limit${reason !== '' ? ` (${reason})` : ''}`
      : reason !== '' ? `Held: ${reason}` : 'Held: paused by hand');
  }
  return lines;
}
