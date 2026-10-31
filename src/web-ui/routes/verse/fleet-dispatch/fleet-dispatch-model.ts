import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { incidents } from '../command/incidents-model.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';

type Lane = FleetRunsV1['lanes'][number];
interface Context { lastTickAgeMs: number | null; paused: boolean | null; claudeLane: string | null; nowMs: number }
export interface LaneVerdict {
  lane: string;
  kind: 'held' | 'down' | 'paused' | 'at-target' | 'filling' | 'starved' | 'idle' | 'over';
  headline: string; action: string | null; free: number;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
}

export function laneVerdict(lane: Lane, ctx: Context): LaneVerdict {
  const { running, target, queued } = lane;
  const free = Math.max(0, target - running);
  const result = (kind: LaneVerdict['kind'], headline: string, tone: LaneVerdict['tone'], action: string | null = null): LaneVerdict =>
    ({ lane: lane.lane, kind, headline, action, free, tone });
  if (lane.held) {
    const reason = lane.heldReason ?? 'no reason given';
    return result('held', `held — ${reason}`, 'warn', /usage|limit|quota/i.test(reason)
      ? 'Waits for the provider reset; put jobs on other lanes' : /token|auth|login/i.test(reason) ? 'Re-authenticate this lane' : null);
  }
  if (lane.lane === 'claude' && /down/i.test(ctx.claudeLane ?? '')) return result('down', `lane down — ${ctx.claudeLane}`, 'danger', 'Run ~/.ashlr-runs/bin/fix-claude-lane.sh');
  if (ctx.paused === true) return result('paused', 'dispatch paused', 'warn', 'Dispatch is paused; clear the pause switch');
  if (running >= target && target > 0) return running > target ? result('over', `${running} running — over target ${target}`, 'warn') : result('at-target', 'at target', 'ok');
  if (running < target && queued > 0) {
    if (ctx.lastTickAgeMs !== null && ctx.lastTickAgeMs > 5 * 60_000) return result('starved', `${free} free, ${queued} queued — last tick ${Math.floor(ctx.lastTickAgeMs / 60_000)} min ago`, 'danger', 'Dispatch is not launching: check the tick and lane holds');
    return result('filling', `${free} free, ${queued} queued — launching`, 'warn');
  }
  return result('idle', `${free} free, ${queued} queued — idle`, 'neutral', 'Write more jobs for this lane');
}

export function supplySummary(lanes: readonly Lane[]) {
  const totals = lanes.reduce((sum, lane) => ({ freeSlots: sum.freeSlots + Math.max(0, lane.target - lane.running), queued: sum.queued + lane.queued, running: sum.running + lane.running, target: sum.target + lane.target }), { freeSlots: 0, queued: 0, running: 0, target: 0 });
  const bound: 'supply' | 'demand' | 'balanced' = totals.freeSlots > 0 && totals.queued === 0 ? 'demand' : totals.queued > totals.freeSlots ? 'supply' : 'balanced';
  const text = bound === 'demand' ? 'Free capacity is waiting for more jobs.' : bound === 'supply' ? 'Queued work exceeds free capacity.' : 'Queued work fits available capacity.';
  return { ...totals, bound, text };
}

export function tickAgeMs(lastTick: string | null, nowMs: number): number | null {
  const tick = lastTick === null ? NaN : Date.parse(lastTick);
  return Number.isFinite(tick) && Number.isFinite(nowMs) ? Math.max(0, nowMs - tick) : null;
}

export function readDispatch(raw: unknown, nowMs: number) {
  if (!isFleetRuns(raw)) return null;
  const lastTickAgeMs = tickAgeMs(raw.lastTick, nowMs);
  const rank = { danger: 0, warn: 1, ok: 2, neutral: 2 };
  const verdicts = raw.lanes.map(lane => laneVerdict(lane, { lastTickAgeMs, paused: raw.paused, claudeLane: raw.claudeLane, nowMs }))
    .sort((a, b) => rank[a.tone] - rank[b.tone] || a.lane.localeCompare(b.lane));
  return { verdicts, supply: supplySummary(raw.lanes), incidents: incidents(raw, nowMs).filter(item => item.id === 'stall'), lastTickAgeMs, sourceState: raw.sources.runsDir };
}
