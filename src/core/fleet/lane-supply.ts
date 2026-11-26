/**
 * lane-supply.ts — one glance: does every lane have work, and does it have usage left?
 *
 * The alarm is "idle with usage left": a lane with free slots, nothing queued, no lane-open
 * supply the market could place on it, and pool usage still available. The Leader card, the
 * phone and `phm fleet lane-supply` all read this one typed report.
 *
 * Built from the lane console snapshot (queue depth, running, target, hold, pool credit) plus the
 * last self-tick record (planner pass time and the autofill decision). Pure: no I/O, no clock.
 * A fact that could not be read is null / unknown, never zero.
 */
import type { FleetLaneSnapshot, FleetLaneView } from './lane-console.js';
import { hooksFromPlannerReport, type SelfTickHook } from './self-tick-hooks.js';

export const LANE_SUPPLY_SCHEMA = 'fleet.lane-supply.v1' as const;
export const LANE_SUPPLY_PATH = '/api/verse/fleet/lane-supply';

export type LaneSupplyVerdict =
  | 'busy'
  | 'idle-with-usage-left'
  | 'idle-usage-unknown'
  | 'open-supply'
  | 'out-of-usage'
  | 'held'
  | 'unknown';

export interface LaneSupplyLane {
  lane: string;
  running: number | null;
  /** Null when the lane has no target row (a null ceiling): the lane cannot be called idle. */
  target: number | null;
  /** target - running, never below 0; 0 while held; null when running or target is unknown. */
  freeSlots: number | null;
  queued: number | null;
  /** 0..100 of the pool used; null when unmeasured or stale. */
  usedPct: number | null;
  leftPct: number | null;
  resetAt: string | null;
  hoursToReset: number | null;
  verdict: LaneSupplyVerdict;
  /** The hold reason or "until <time>" for a held or out-of-usage lane; else null. */
  detail: string | null;
  /** One plain sentence, e.g. "claude idle: 6 free slots, 68% left". */
  text: string;
}

export interface LaneSupplyPlanner {
  /** 'unknown' when queue/self-tick-last.json is missing, unreadable or has no planner step. */
  state: 'known' | 'unknown';
  lastPassAt: string | null;
  ageSeconds: number | null;
}

export interface LaneSupplyAutofill {
  /** The autofill hook's state from the last planner pass; 'unknown' when no pass is recorded. */
  state: SelfTickHook['state'] | 'unknown';
  items: number | null;
  note: string | null;
}

export interface LaneSupplyReport {
  schema: typeof LANE_SUPPLY_SCHEMA;
  generatedAt: string;
  lanes: LaneSupplyLane[];
  /** The idle-with-usage-left alarm lanes, most free slots first. */
  idle: string[];
  /** The one Leader-card line, or null when no lane is idle with usage left. */
  alarm: string | null;
  planner: LaneSupplyPlanner;
  autofill: LaneSupplyAutofill;
}

const HOUR_MS = 3_600_000;
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
const pct = (n: number): number => Math.round(n);

function resetWords(resetAt: string | null): string {
  const at = resetAt === null ? NaN : Date.parse(resetAt);
  return Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'its next reset (time unknown)';
}

/** The verdict and plain sentence for one lane. `openRows` is the snapshot's lane-open READY count: supply the market may place on any lane, so a positive count keeps a free lane from reading as idle. */
export function laneSupplyLane(view: FleetLaneView, nowMs: number, openRows: number | null = null): LaneSupplyLane {
  const running = view.liveJobs;
  const target = view.slotTarget;
  const held = view.hold?.held === true;
  const left = view.credit.remainingPct;
  const leftPct = left === null ? null : Math.max(0, Math.min(100, left));
  const resetMs = view.credit.resetAt === null ? NaN : Date.parse(view.credit.resetAt);
  const hoursToReset = Number.isFinite(resetMs) ? Math.max(0, Math.round(((resetMs - nowMs) / HOUR_MS) * 10) / 10) : null;
  const free = held ? 0 : running === null || target === null ? null : Math.max(0, target - running);
  const row = {
    lane: view.lane, running, target, freeSlots: free, queued: view.queueDepth,
    usedPct: leftPct === null ? null : pct(100 - leftPct), leftPct: leftPct === null ? null : pct(leftPct),
    resetAt: view.credit.resetAt, hoursToReset,
  };
  const idle = free !== null && free > 0 && view.queueDepth === 0;
  const openSupply = typeof openRows === 'number' && Number.isSafeInteger(openRows) && openRows > 0;
  let verdict: LaneSupplyVerdict;
  let text: string;
  let detail: string | null = null;
  if (held) { verdict = 'held'; detail = view.hold?.reason ?? null; text = `${view.lane} held${detail ? `: ${detail}` : ''}`; }
  else if (leftPct !== null && leftPct <= 0) { verdict = 'out-of-usage'; detail = `until ${resetWords(view.credit.resetAt)}`; text = `${view.lane} out of usage ${detail}`; }
  else if (idle && leftPct !== null && openSupply) { verdict = 'open-supply'; text = `${view.lane} open supply: ${plural(free, 'free slot')}, ${pct(leftPct)}% left, ${plural(openRows, 'open row')} wait`; }
  else if (idle && leftPct !== null) { verdict = 'idle-with-usage-left'; text = `${view.lane} idle: ${plural(free, 'free slot')}, ${pct(leftPct)}% left`; }
  else if (idle) { verdict = 'idle-usage-unknown'; text = `${view.lane} idle: ${plural(free, 'free slot')}, usage unknown`; }
  else if (free === null) { verdict = 'unknown'; text = `${view.lane}: running or target unknown`; }
  else { verdict = 'busy'; text = `${view.lane} busy: ${running} of ${target} running, ${view.queueDepth ?? 0} queued`; }
  return { ...row, verdict, detail, text };
}

/** Read the planner pass time and autofill decision out of the stored self-tick record text. */
export function readPlannerFacts(recordJson: string | null, nowMs: number): Pick<LaneSupplyReport, 'planner' | 'autofill'> {
  const unknown = { planner: { state: 'unknown', lastPassAt: null, ageSeconds: null }, autofill: { state: 'unknown', items: null, note: null } } as const;
  if (recordJson === null) return unknown;
  try {
    const row: unknown = JSON.parse(recordJson);
    if (typeof row !== 'object' || row === null) return unknown;
    const rec = row as { at?: unknown; mode?: unknown; state?: unknown; steps?: unknown };
    const at = typeof rec.at === 'string' ? Date.parse(rec.at) : NaN;
    const step = Array.isArray(rec.steps) ? rec.steps.find((s: unknown) => typeof s === 'object' && s !== null && (s as { step?: unknown }).step === 'planner-tick') : undefined;
    if (!Number.isFinite(at) || rec.state !== 'ran' || !step) return unknown;
    const hook = hooksFromPlannerReport((step as { report?: unknown }).report, rec.mode === 'dry-run' ? 'dry-run' : 'apply')[0]!;
    return {
      planner: { state: 'known', lastPassAt: new Date(at).toISOString(), ageSeconds: Math.max(0, Math.floor((nowMs - at) / 1000)) },
      autofill: { state: hook.state, items: hook.items, note: hook.note },
    };
  } catch { return unknown; }
}

export function buildLaneSupply(snapshot: FleetLaneSnapshot, selfTickRecord: string | null, nowMs: number): LaneSupplyReport {
  const openRows = snapshot.starved?.open_rows ?? null;
  const lanes = snapshot.lanes.map(view => laneSupplyLane(view, nowMs, openRows)).sort((a, b) => a.lane.localeCompare(b.lane));
  const idle = lanes.filter(l => l.verdict === 'idle-with-usage-left').sort((a, b) => (b.freeSlots ?? 0) - (a.freeSlots ?? 0));
  return {
    schema: LANE_SUPPLY_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    lanes,
    idle: idle.map(l => l.lane),
    alarm: idle.length === 0 ? null : idle.map(l => l.text).join('; '),
    ...readPlannerFacts(selfTickRecord, nowMs),
  };
}

/** Only a well-formed report is one; older or newer servers return null so a card says nothing. */
export function asLaneSupplyReport(raw: unknown): LaneSupplyReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Partial<LaneSupplyReport>;
  return r.schema === LANE_SUPPLY_SCHEMA && Array.isArray(r.lanes) && Array.isArray(r.idle) && (r.alarm === null || typeof r.alarm === 'string') ? r as LaneSupplyReport : null;
}

function ageWords(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

const VERDICT_WORDS: Record<LaneSupplyVerdict, string> = {
  busy: 'busy', 'idle-with-usage-left': 'IDLE WITH USAGE LEFT', 'idle-usage-unknown': 'idle, usage unknown',
  'open-supply': 'open supply', 'out-of-usage': 'out of usage', held: 'held', unknown: 'unknown',
};

/** The plain-text table `phm fleet lane-supply` prints. */
export function formatLaneSupply(report: LaneSupplyReport): string {
  const out = report.lanes.length === 0 ? ['no lanes reported'] : report.lanes.map(l => {
    const slots = l.running === null || l.target === null ? 'running/target unknown' : `${l.running}/${l.target} running`;
    const use = l.usedPct === null ? 'usage unknown' : `${l.usedPct}% used${l.hoursToReset === null ? '' : `, resets in ${l.hoursToReset} h`}`;
    return `${l.lane}: ${slots}, ${l.queued ?? 'unknown'} queued, ${use}; ${VERDICT_WORDS[l.verdict]}${l.detail ? ` ${l.detail}` : ''}`;
  });
  out.push(report.alarm === null ? 'No lane is idle with usage left.' : `ALARM: ${report.alarm}`);
  out.push(report.planner.state === 'known' ? `Planner last pass: ${ageWords(report.planner.ageSeconds ?? 0)}.` : 'Planner last pass: unknown (no self-tick record).');
  out.push(report.autofill.state === 'unknown' ? 'Last autofill: unknown.' : `Last autofill: ${report.autofill.state}${report.autofill.items === null ? '' : `, ${plural(report.autofill.items, 'job')}`}${report.autofill.note ? ` (${report.autofill.note})` : ''}.`);
  return out.join('\n');
}
