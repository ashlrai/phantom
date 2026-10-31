import type { AppNotification, NotificationSeverity } from './types.js';

type RecordValue = Record<string, unknown>;
interface FleetRuns {
  generatedAt: string;
  paused?: boolean;
  claudeLane: string | null;
  lanes: Array<{ lane: string; running: number; target: number; queued: number; held: boolean; heldReason?: string | null }>;
  workers: Array<{ ageSeconds: number | null }>;
  mergesLastHour: { count: number | null };
  drop: { pending: Array<{ lane: string; file: string }>; done: unknown } | null;
  events: Array<{ at: string; kind: string }>;
}
const record = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const scrub = (v: string) => v.replace(/[A-Za-z0-9_-]{32,}/g, '…');

/** Narrow only the public projection; arbitrary or incomplete shapes are silent. */
function isFleetRuns(v: unknown): v is FleetRuns {
  return record(v) && date(v.generatedAt) && (v.paused === undefined || typeof v.paused === 'boolean')
    && nullableString(v.claudeLane)
    && Array.isArray(v.lanes) && v.lanes.every((l: unknown) => record(l)
      && typeof l.lane === 'string' && l.lane.length > 0 && count(l.running) && count(l.target) && count(l.queued)
      && typeof l.held === 'boolean' && (l.heldReason === undefined || nullableString(l.heldReason)))
    && Array.isArray(v.workers) && v.workers.every((w: unknown) => record(w) && (w.ageSeconds === null || count(w.ageSeconds)))
    && record(v.mergesLastHour) && (v.mergesLastHour.count === null || count(v.mergesLastHour.count))
    && (v.drop === null || (record(v.drop) && 'done' in v.drop && Array.isArray(v.drop.pending)
      && v.drop.pending.every((p: unknown) => record(p) && typeof p.lane === 'string' && typeof p.file === 'string')))
    && Array.isArray(v.events) && v.events.every((e: unknown) => record(e) && date(e.at) && typeof e.kind === 'string');
}

/** Pure derivation: stable incident ids let reconciliation retire resolved issues. */
export function deriveFleetRunsNotifications(data: unknown, now: number): AppNotification[] {
  if (!isFleetRuns(data)) return [];
  const out: AppNotification[] = [];
  const add = (id: string, severity: NotificationSeverity, title: string, detail: string) => {
    out.push({ id, category: 'fleet', severity, title, detail, ts: data.generatedAt });
  };
  const ages = data.workers.flatMap((w) => w.ageSeconds === null ? [] : [w.ageSeconds]);
  const starts = data.events.filter((e) => /^(launch|start)$/.test(e.kind)).map((e) => Date.parse(e.at));
  const age = ages.length ? Math.min(...ages) : starts.length ? (now - Math.max(...starts)) / 1000 : null;
  if ((age === null || age >= 1800) && data.mergesLastHour.count === 0 && data.paused !== true) {
    add('fleet-stall', 'critical', 'Fleet stalled', age === null
      ? 'Last start is unknown and nothing merged in the last hour.'
      : `Nothing started for ${Math.floor(age / 60)} min and nothing merged in the last hour.`);
  }
  if (data.claudeLane && /down|rejected|invalid/i.test(data.claudeLane)) {
    add('fleet-claude-lane-down', 'high', 'Claude lane is down', scrub(data.claudeLane));
  }
  for (const l of data.lanes) {
    if (l.held) add(`fleet-lane-held-${l.lane}`, 'medium', `${scrub(l.lane)} lane is held`,
      l.heldReason ? scrub(l.heldReason) : 'Lane is held.');
  }
  for (const l of data.lanes) {
    if (l.running === 0 && l.target > 0 && l.queued > 0 && !l.held) {
      add(`fleet-lane-idle-${l.lane}`, 'low', `${scrub(l.lane)} lane is idle`, `${l.queued} queued jobs but nothing is launching.`);
    }
  }
  if (data.drop && data.drop.pending.length > 0) {
    const detail = `${data.drop.pending.length} leader job files waiting for ingest`;
    add('fleet-drop-pending', 'info', 'Leader jobs awaiting ingest', detail);
  }
  return out;
}
