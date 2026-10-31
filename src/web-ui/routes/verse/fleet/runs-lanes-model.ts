import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { etaText, nextPassEta } from './next-pass-eta.js';
import { queueDrainEta } from './queue-drain-eta.js';
import { tickStaleness } from './tick-staleness.js';

export type RunsLane = FleetRunsV1['lanes'][number];
export type RunsLanes = Pick<FleetRunsV1, 'generatedAt' | 'lastTick' | 'paused' | 'switches' | 'lanes'> & {
  sources: Pick<FleetRunsV1['sources'], 'runsDir'>;
  leaders?: FleetRunsV1['leaders'];
  codexPersonal?: FleetRunsV1['codexPersonal'];
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableCount = (v: unknown): v is number | null => v === null || count(v);
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const nullableFinite = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
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
  const leaders = Array.isArray(v.leaders) ? v.leaders.filter((leader): leader is FleetRunsV1['leaders'][number] =>
    record(leader) && typeof leader.label === 'string' && nullableFinite(leader.ageSeconds)) : undefined;
  const codexPersonal = record(v.codexPersonal) && nullableFinite(v.codexPersonal.usedPct)
    && nullableString(v.codexPersonal.resetsAt) && nullableString(v.codexPersonal.asOf)
    ? { usedPct: v.codexPersonal.usedPct, resetsAt: v.codexPersonal.resetsAt, asOf: v.codexPersonal.asOf } : null;
  return { generatedAt: v.generatedAt, lastTick: v.lastTick, paused: v.paused, switches: [...v.switches],
    ...(leaders ? { leaders } : {}), ...(v.codexPersonal !== undefined ? { codexPersonal } : {}),
    sources: { runsDir: v.sources.runsDir as FleetRunsV1['sources']['runsDir'] },
    lanes: v.lanes.map(l => ({ lane: l.lane, running: l.running, target: l.target, queued: l.queued,
      held: l.held, heldReason: l.heldReason, tokensLastHour: l.tokensLastHour, merged24h: l.merged24h, mergeRate24h: l.mergeRate24h })) };
}
export const sortLanes = (lanes: RunsLane[]): RunsLane[] => [...lanes].sort((a, b) => b.running - a.running || a.lane.localeCompare(b.lane));
export const laneFill = (lane: RunsLane): string => `${lane.running} / ${lane.target}`;
export function laneDrain(lane: RunsLane): ReturnType<typeof queueDrainEta> {
  // Oct 31 median job durations, in minutes.
  const avgJobMinutes = lane.lane === 'codex-personal' ? 13 : lane.lane === 'devin' ? 70 : 15;
  const result = queueDrainEta({ ...lane, avgJobMinutes });
  // A lane with no capacity cannot drain until its target changes.
  if (!lane.held && lane.target === 0 && lane.queued > 0) {
    return { ...result, state: 'saturated', drainMinutes: null };
  }
  return result;
}
export function drainText(result: ReturnType<typeof queueDrainEta> & { queued: number }): string {
  switch (result.state) {
    case 'held': return 'held';
    case 'idle': return `${result.freeSlots} free · waiting for jobs`;
    case 'draining': return `queued ${result.queued} · drains in ~${result.drainMinutes} min`;
    case 'saturated': return `saturated · ${result.queued} queued, 0 free`;
  }
}
export const laneNote = (lane: RunsLane): string => lane.held
  ? `held: ${lane.heldReason || 'reason unknown'}`
  : drainText({ ...laneDrain(lane), queued: lane.queued });
export function headerText(data: RunsLanes, nowMs: number): string {
  if (data.paused) return 'dispatcher paused';
  if (data.switches.length) return `switches on: ${data.switches.join(', ')}`;
  const tick = tickStaleness(data.lastTick, nowMs);
  return `${tick.text.replace(/(\d+) s ago$/, '$1s ago')} · ${tick.level}`;
}
export function headerExtras(data: RunsLanes, nowMs: number): string[] {
  const parts: string[] = [];
  const ages = data.leaders?.flatMap(leader => leader.ageSeconds !== null && Number.isFinite(leader.ageSeconds) ? [leader.ageSeconds] : []) ?? [];
  const generatedMs = Date.parse(data.generatedAt);
  if (ages.length && Number.isFinite(generatedMs)) {
    const text = etaText(nextPassEta(generatedMs - Math.min(...ages) * 1_000, nowMs));
    parts.push(text.replace('next pass', 'next leader pass').replace('pass overdue', 'leader pass overdue'));
  }
  const personal = data.codexPersonal;
  if (personal && personal.usedPct !== null) {
    const resetMs = personal.resetsAt === null ? NaN : Date.parse(personal.resetsAt);
    const reset = Number.isFinite(resetMs) ? `, resets ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(resetMs)}` : '';
    parts.push(`personal Codex ${personal.usedPct}%${reset}`);
  }
  return parts;
}
