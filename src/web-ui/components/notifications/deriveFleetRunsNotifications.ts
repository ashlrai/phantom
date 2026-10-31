import type { AppNotification, NotificationSeverity } from './types.js';
import { ackState, newestLeaderPassMs, parseInboxAt } from '../../routes/verse/fleet/interject-ack-model.js';
import { LEADER_OVERDUE_MS } from '../../routes/verse/shell/fleet-needs-you.js';
import { paneLinkUrl } from '../../routes/verse/dock/pane-link.js';

type RecordValue = Record<string, unknown>;
interface FleetRuns {
  generatedAt: string;
  paused?: boolean;
  memFreePct?: number | null;
  diskFreeGb?: number | null;
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
const etTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const masonSource = (source: string) => {
  const value = source.trim().toLowerCase();
  return !/leader|system/.test(value) && (value.includes('mason')
    || /^(desktop|phantom desktop|mobile|phone|telegram|email|terminal|cli|page|fleet-say)$/.test(value));
};
const inboxDetail = (text: string) => scrub(text.replace(/\s+/g, ' ').trim().replace(/\S*[\\/]\S*/g, '…')).slice(0, 80).trim();
const textHash = (text: string) => {
  let hash = 2166136261;
  for (let i = 0; i < Math.min(text.length, 24); i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
};

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
  const base = typeof window === 'undefined' ? undefined : new URL('/verse/', window.location.href).toString();
  const add = (id: string, severity: NotificationSeverity, title: string, detail: string, target?: { label: string; pane: string }) => {
    const actionHref = target ? paneLinkUrl(target.pane, null, false, base) : null;
    out.push({ id, category: 'fleet', severity, title, detail, ts: data.generatedAt,
      ...(actionHref && target ? { actionLabel: target.label, actionHref } : {}) });
  };
  const ages = data.workers.flatMap((w) => w.ageSeconds === null ? [] : [w.ageSeconds]);
  const starts = data.events.filter((e) => /^(launch|start)$/.test(e.kind)).map((e) => Date.parse(e.at));
  const age = ages.length ? Math.min(...ages) : starts.length ? (now - Math.max(...starts)) / 1000 : null;
  if ((age === null || age >= 1800) && data.mergesLastHour.count === 0 && data.paused !== true) {
    add('fleet-stall', 'critical', 'Fleet stalled', age === null
      ? 'Last start is unknown and nothing merged in the last hour.'
      : `Nothing started for ${Math.floor(age / 60)} min and nothing merged in the last hour.`,
      { label: 'Open lanes', pane: 'fleet-lanes' });
  }
  const disk = count(data.diskFreeGb) ? data.diskFreeGb : null;
  const memory = count(data.memFreePct) ? data.memFreePct : null;
  if ((disk !== null && disk < 25) || (memory !== null && memory < 10)) {
    const critical = (disk !== null && disk < 10) || (memory !== null && memory < 5);
    const detail = [disk === null ? null : `Disk ${disk} GB free`, memory === null ? null : `memory ${memory}% free`]
      .filter((part) => part !== null).join(' · ');
    add('fleet-host-pressure', critical ? 'critical' : 'high', 'Host under pressure', detail,
      { label: 'Open host', pane: 'fleet-host' });
  }
  if (data.claudeLane && /down|rejected|invalid/i.test(data.claudeLane)) {
    add('fleet-claude-lane-down', 'high', 'Claude lane is down', scrub(data.claudeLane), { label: 'Open host', pane: 'fleet-host' });
  }
  for (const l of data.lanes) {
    if (l.held) add(`fleet-lane-held-${l.lane}`, 'medium', `${scrub(l.lane)} lane is held`,
      l.heldReason ? scrub(l.heldReason) : 'Lane is held.', { label: 'Open lanes', pane: 'fleet-lanes' });
  }
  for (const l of data.lanes) {
    if (l.running === 0 && l.target > 0 && l.queued > 0 && !l.held) {
      add(`fleet-lane-idle-${l.lane}`, 'low', `${scrub(l.lane)} lane is idle`, `${l.queued} queued jobs but nothing is launching.`,
        { label: 'Open lanes', pane: 'fleet-lanes' });
    }
  }
  if (data.drop && data.drop.pending.length > 0) {
    const detail = `${data.drop.pending.length} leader job files waiting for ingest`;
    add('fleet-drop-pending', 'info', 'Leader jobs awaiting ingest', detail, { label: 'Open leader journal', pane: 'leader-journal' });
  }
  // The inbox and leaders are optional in older or incomplete projections.
  const snapshot = data as unknown as RecordValue;
  if (Array.isArray(snapshot.inbox)) {
    const leaders = Array.isArray(snapshot.leaders) ? snapshot.leaders.flatMap((leader: unknown) => {
      if (!record(leader) || (leader.ageSeconds !== null && !count(leader.ageSeconds))) return [];
      return [{ ageSeconds: leader.ageSeconds as number | null }];
    }) : undefined;
    const newestPass = newestLeaderPassMs(leaders, Date.parse(data.generatedAt));
    for (const entry of snapshot.inbox) {
      if (!record(entry) || typeof entry.at !== 'string' || typeof entry.source !== 'string'
        || typeof entry.text !== 'string' || !masonSource(entry.source)) continue;
      const at = parseInboxAt(entry.at, now);
      if (at === null || at > now || now - at > 24 * 60 * 60_000) continue;
      const state = ackState(at, newestPass);
      const time = etTime.format(at);
      const detail = inboxDetail(entry.text);
      if (state === 'seen' && newestPass !== null) {
        add(`fleet-inbox-read:${entry.at}:${textHash(entry.text)}`, 'critical',
          `Your ${time} message was read by the ${etTime.format(newestPass)} leader pass`, detail, { label: 'Open inbox', pane: 'fleet-inbox' });
      } else if (now - at >= LEADER_OVERDUE_MS) {
        add(`fleet-inbox-overdue:${entry.at}`, 'medium',
          `Your ${time} message has waited ${Math.floor((now - at) / 60_000)} min for a leader pass`, detail, { label: 'Open inbox', pane: 'fleet-inbox' });
      }
    }
  }
  return out;
}
