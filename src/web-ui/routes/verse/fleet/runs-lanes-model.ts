import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { tickStaleness } from './tick-staleness.js';

export type RunsLane = FleetRunsV1['lanes'][number];
export type RunsLanes = Pick<FleetRunsV1, 'generatedAt' | 'lastTick' | 'paused' | 'switches' | 'lanes'> & {
  sources: Pick<FleetRunsV1['sources'], 'runsDir'>;
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableCount = (v: unknown): v is number | null => v === null || count(v);
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
function validLane(v: unknown): v is RunsLane {
  return record(v) && typeof v.lane === 'string' && v.lane.trim().length > 0
    && count(v.running) && count(v.target) && count(v.queued) && typeof v.held === 'boolean'
    && nullableString(v.heldReason) && nullableCount(v.tokensLastHour) && nullableCount(v.merged24h)
    && (v.mergeRate24h === null || (typeof v.mergeRate24h === 'number' && Number.isFinite(v.mergeRate24h) && v.mergeRate24h >= 0));
}
export function narrowRunsLanes(v: unknown): RunsLanes | null {
  if (!record(v) || v.v !== 1 || typeof v.generatedAt !== 'string' || !nullableString(v.lastTick)
    || !(v.paused === null || typeof v.paused === 'boolean') || !Array.isArray(v.switches)
    || !v.switches.every((s): s is string => typeof s === 'string') || !record(v.sources)
    || typeof v.sources.runsDir !== 'string' || !['healthy', 'degraded', 'missing', 'not-landed'].includes(v.sources.runsDir)
    || !Array.isArray(v.lanes) || !v.lanes.every(validLane)) return null;
  return { generatedAt: v.generatedAt, lastTick: v.lastTick, paused: v.paused, switches: [...v.switches],
    sources: { runsDir: v.sources.runsDir as FleetRunsV1['sources']['runsDir'] },
    lanes: v.lanes.map(l => ({ lane: l.lane, running: l.running, target: l.target, queued: l.queued,
      held: l.held, heldReason: l.heldReason, tokensLastHour: l.tokensLastHour, merged24h: l.merged24h, mergeRate24h: l.mergeRate24h })) };
}
export const sortLanes = (lanes: RunsLane[]): RunsLane[] => [...lanes].sort((a, b) => b.running - a.running || a.lane.localeCompare(b.lane));
export const laneFill = (lane: RunsLane): string => `${lane.running} / ${lane.target}`;
export const laneNote = (lane: RunsLane): string | null => lane.held ? `held: ${lane.heldReason || 'reason unknown'}` : lane.queued > 0 ? `queued ${lane.queued}` : null;
export function headerText(data: RunsLanes, nowMs: number): string {
  if (data.paused) return 'dispatcher paused';
  if (data.switches.length) return `switches on: ${data.switches.join(', ')}`;
  const tick = tickStaleness(data.lastTick, nowMs);
  return `${tick.text.replace(/(\d+) s ago$/, '$1s ago')} · ${tick.level}`;
}
