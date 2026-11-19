/**
 * The Lanes board's words and marks, derived only from GET /api/verse/fleet/runs (the read `phm fleet runs --json`
 * prints). Pure. A reading the snapshot does not hold is null here and drawn as "unknown", never as zero.
 */
import { relativeText, type FleetRuns } from '../ops/ops-runs-model.js';
import { formatTokens } from './fleet-lanes-model.js';

type Lane = FleetRuns['lanes'][number];
export type LaneState = 'down' | 'held' | 'off' | 'over' | 'full' | 'open';
export type Pip = 'running' | 'over' | 'open';
/** Past this many slots a lane draws one bar instead of a square per slot. */
export const PIP_LIMIT = 32;

export interface LaneCard extends Lane {
  state: LaneState;
  /** The state in words. Null when a badge already says it (Down, Held). */
  stateText: string | null;
  /** One mark per slot: running, running beyond the target, or open. Null when there are none or too many to count by eye. */
  pips: Pip[] | null;
  /** Share of the target that is running, for the bar a large lane draws instead of pips. */
  fillPct: number | null;
}

const whole = (value: number): number => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export function laneCard(lane: Lane, claudeDown: boolean): LaneCard {
  const running = whole(lane.running), target = whole(lane.target);
  const down = claudeDown && lane.lane === 'claude' && target > 0;
  const state: LaneState = down ? 'down' : lane.held ? 'held' : target === 0 && running === 0 ? 'off'
    : running > target ? 'over' : running === target ? 'full' : 'open';
  const stateText = state === 'off' ? 'Target 0' : state === 'full' ? 'Full'
    : state === 'over' ? `${running - target} over target` : state === 'open' ? `${target - running} open` : null;
  const slots = Math.max(running, target);
  const pips = slots === 0 || slots > PIP_LIMIT ? null
    : Array.from({ length: slots }, (_, i): Pip => i >= running ? 'open' : i >= target ? 'over' : 'running');
  return { ...lane, state, stateText, pips, fillPct: target > 0 ? Math.min(100, running / target * 100) : null };
}

/** What is running against what was asked for, across every lane, and how many lanes are held. */
export function boardHeadline(runs: FleetRuns): string {
  if (runs.lanes.length === 0) return 'No lanes reported.';
  const running = runs.lanes.reduce((sum, lane) => sum + whole(lane.running), 0);
  const target = runs.lanes.reduce((sum, lane) => sum + whole(lane.target), 0);
  const held = runs.lanes.filter(lane => lane.held).length;
  return `${running} of ${plural(target, 'slot')} running${held ? `, ${plural(held, 'lane')} held` : ''}.`;
}

/** Merges in the last hour and how long ago the dispatcher last ticked; either may be unknown. */
export function pulseLine(runs: FleetRuns, nowMs: number): string {
  const merged = runs.mergesLastHour.count === null ? 'Merges last hour unknown' : `${runs.mergesLastHour.count} merged last hour`;
  const at = runs.lastTick === null ? NaN : Date.parse(runs.lastTick);
  const elapsed = (nowMs - at) / 1000;
  const tick = !Number.isFinite(at) ? 'last tick unknown'
    : `last tick ${elapsed >= 0 && elapsed < 60 ? `${Math.floor(elapsed)} s ago` : relativeText(runs.lastTick, nowMs)}`;
  return `${merged} · ${tick}`;
}

export interface StripSegment { lane: string; weight: number; fillPct: number; state: LaneState }

/** The fleet's slots as one strip: a segment per lane as wide as its slots, filled by what is running. */
export function fleetStrip(cards: readonly LaneCard[]): { segments: StripSegment[]; label: string } | null {
  const segments = cards.flatMap((card): StripSegment[] => {
    const running = whole(card.running), weight = Math.max(running, whole(card.target));
    return weight === 0 ? [] : [{ lane: card.lane, weight, fillPct: running / weight * 100, state: card.state }];
  });
  if (segments.length === 0) return null;
  return { segments, label: `Fleet slots: ${cards.filter(card => segments.some(segment => segment.lane === card.lane))
    .map(card => `${card.lane} ${whole(card.running)} of ${whole(card.target)}`).join(', ')}` };
}

export interface LaneFact { label: string; value: string | null }
const known = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const rate = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** The lane's labelled readings. `value: null` is drawn as "unknown". */
export function laneFacts(lane: Lane): LaneFact[] {
  return [
    { label: 'Tokens last hour', value: known(lane.tokensLastHour) ? formatTokens(lane.tokensLastHour) : null },
    { label: 'Merged in 24 h', value: known(lane.merged24h) ? String(lane.merged24h) : null },
    { label: 'Merge rate', value: known(lane.mergeRate24h) ? `${rate.format(lane.mergeRate24h)}/h` : null },
  ];
}
