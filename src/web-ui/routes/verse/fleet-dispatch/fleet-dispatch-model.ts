import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { incidents } from '../command/incidents-model.js';
import { parseHeldReason } from '../fleet/held-reason.js';
import { durationText } from '../ops/ops-lane-model.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';

type Lane = FleetRunsV1['lanes'][number];
interface Context { lastTickAgeMs: number | null; paused: boolean | null; claudeLane: string | null; nowMs: number; youngestWorkerAgeMs: ReadonlyMap<string, number>; workerLanes?: ReadonlySet<string> }
export interface LaneVerdict {
  lane: string;
  kind: 'held' | 'down' | 'paused' | 'at-target' | 'filling' | 'starved' | 'stalled' | 'idle' | 'over';
  headline: string; action: string | null; free: number;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  stall?: { queued: number; duration: string };
}

export function youngestWorkerAges(workers: ReadonlyArray<{ lane: string; ageSeconds: number | null }>): Map<string, number> {
  const ages = new Map<string, number>();
  for (const { lane, ageSeconds } of workers) {
    if (ageSeconds === null) continue;
    const ageMs = ageSeconds * 1000;
    ages.set(lane, Math.min(ages.get(lane) ?? ageMs, ageMs));
  }
  return ages;
}

const easternTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function heldDetails(reason: string | null, nowMs: number): { headline: string; expired: boolean } {
  const parsed = parseHeldReason(reason);
  const headline = `held — ${parsed?.label || 'no reason given'}`;
  const at = parsed?.at ? Date.parse(parsed.at) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return { headline, expired: false };
  if (parsed?.until) {
    if (at <= nowMs) return { headline: `${headline} · reset time passed; lane should resume`, expired: true };
    const parts = easternTime.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
    const time = `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ET`;
    return { headline: `${headline} · back in ${durationText(at - nowMs)} (${time})`, expired: false };
  }
  return { headline: `${headline} · ${durationText(nowMs - at)} ago`, expired: false };
}

export function heldHeadline(reason: string | null, nowMs: number): string {
  return heldDetails(reason, nowMs).headline;
}

export function laneVerdict(lane: Lane, ctx: Context): LaneVerdict {
  const { running, target, queued } = lane;
  const free = Math.max(0, target - running);
  const result = (kind: LaneVerdict['kind'], headline: string, tone: LaneVerdict['tone'], action: string | null = null): LaneVerdict =>
    ({ lane: lane.lane, kind, headline, action, free, tone });
  if (lane.held) {
    const reason = lane.heldReason ?? 'no reason given';
    const { headline, expired } = heldDetails(lane.heldReason, ctx.nowMs);
    if (expired) return result('held', headline, 'danger', 'Check the dispatcher: the hold outlived its reset time');
    return result('held', headline, 'warn', /usage|limit|quota/i.test(reason)
      ? 'Waits for the provider reset; put jobs on other lanes' : /token|auth|login/i.test(reason) ? 'Re-authenticate this lane' : null);
  }
  if (lane.lane === 'claude' && /down/i.test(ctx.claudeLane ?? '')) return result('down', `lane down — ${ctx.claudeLane}`, 'danger', 'Run ~/.ashlr-runs/bin/fix-claude-lane.sh');
  if (ctx.paused === true) return result('paused', 'dispatch paused', 'warn', 'Dispatch is paused; clear the pause switch');
  if (running >= target && target > 0) return running > target ? result('over', `${running} running — over target ${target}`, 'warn') : result('at-target', 'at target', 'ok');
  if (running < target && queued > 0) {
    if (ctx.lastTickAgeMs !== null && ctx.lastTickAgeMs > 5 * 60_000) return result('starved', `${free} free, ${queued} queued — last tick ${Math.floor(ctx.lastTickAgeMs / 60_000)} min ago`, 'danger', 'Dispatch is not launching: check the tick and lane holds');
    const ageMs = ctx.youngestWorkerAgeMs.get(lane.lane);
    const duration = ageMs === undefined ? 'this session' : durationText(ageMs);
    if ((ageMs !== undefined && ageMs >= 15 * 60_000) || (ageMs === undefined && !ctx.workerLanes?.has(lane.lane) && free > 0 && ctx.lastTickAgeMs !== null && ctx.lastTickAgeMs < 5 * 60_000)) {
      return { ...result('stalled', `${free} free, ${queued} queued — nothing launched for ${duration}`, 'danger', 'Queued lines are not launching on this lane: check holds, drip limits and dependencies in the dispatcher state'), stall: { queued, duration } };
    }
    return result('filling', `${free} free, ${queued} queued — ${ageMs === undefined ? 'last launch unknown' : `last launch ${duration} ago`}`, 'warn');
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
  const youngestWorkerAgeMs = youngestWorkerAges(raw.workers);
  const workerLanes = new Set(raw.workers.map(worker => worker.lane));
  const rank = { danger: 0, warn: 1, ok: 2, neutral: 2 };
  const verdicts = raw.lanes.map(lane => laneVerdict(lane, { lastTickAgeMs, paused: raw.paused, claudeLane: raw.claudeLane, nowMs, youngestWorkerAgeMs, workerLanes }))
    .sort((a, b) => rank[a.tone] - rank[b.tone] || a.lane.localeCompare(b.lane));
  return { verdicts, supply: supplySummary(raw.lanes), incidents: incidents(raw, nowMs).filter(item => item.id === 'stall'), lastTickAgeMs, sourceState: raw.sources.runsDir };
}
