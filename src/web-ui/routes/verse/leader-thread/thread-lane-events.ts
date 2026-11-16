/**
 * routes/verse/leader-thread/thread-lane-events.ts — lane hold/release
 * transitions as Leader-thread system lines. The lane-targets read already
 * tells the console which lanes are held, why and until when; this module
 * diffs two of those snapshots into "held"/"running again" events, keeps the
 * last snapshot and up to 100 events in localStorage so a reload neither
 * loses the lines nor re-emits them on every poll, and maps the events to
 * the MergedLines mergeThread interleaves by time. Pure; storage is
 * injected, never a secret.
 */
import type { MergedLine } from './thread-merge-model.js';

/** What the diff needs of a lane row; LaneTargetRow covers it. */
export interface LaneHoldState {
  lane: string;
  held: boolean;
  heldReason?: string | null;
  heldUntil?: string | null;
  lastChange?: string | null;
}

export interface LaneEvent {
  lane: string;
  kind: 'held' | 'resumed';
  reason: string | null;
  until: string | null;
  atMs: number;
}

export interface LaneLog {
  /** The last snapshot observed; null until the first read is recorded (baseline). */
  snapshot: LaneHoldState[] | null;
  /** Emitted transitions, oldest first, capped at LANE_LOG_MAX_EVENTS. */
  events: LaneEvent[];
}

export const LANE_LOG_STORAGE_KEY = 'phantom.leaderLaneEvents.v1';
export const LANE_LOG_MAX_EVENTS = 100;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

const isLaneRow = (v: unknown): v is LaneHoldState =>
  record(v) && typeof v.lane === 'string' && typeof v.held === 'boolean'
  && (v.heldReason === undefined || nullableString(v.heldReason))
  && (v.heldUntil === undefined || nullableString(v.heldUntil))
  && (v.lastChange === undefined || nullableString(v.lastChange));

const isLaneEvent = (v: unknown): v is LaneEvent =>
  record(v) && typeof v.lane === 'string' && (v.kind === 'held' || v.kind === 'resumed')
  && nullableString(v.reason) && nullableString(v.until) && Number.isFinite(v.atMs);

/**
 * Diff two snapshots. Only lanes present in both emit, and only on a held-flag
 * flip: a lane appearing for the first time is baseline, a missing previous
 * snapshot is baseline, and a lane still held after a reason edit stays quiet.
 * `atMs` is the row's own lastChange when it parses (the flip's wall time),
 * else the observation time.
 */
export function laneTransitions(prev: readonly LaneHoldState[] | null | undefined, next: readonly LaneHoldState[], nowMs: number): LaneEvent[] {
  if (!prev) return [];
  const before = new Map(prev.map(row => [row.lane, row]));
  const events: LaneEvent[] = [];
  for (const row of next) {
    const old = before.get(row.lane);
    if (!old || old.held === row.held) continue;
    const changed = Date.parse(row.lastChange ?? '');
    events.push({
      lane: row.lane,
      kind: row.held ? 'held' : 'resumed',
      reason: row.held ? row.heldReason ?? null : null,
      until: row.held ? row.heldUntil ?? null : null,
      atMs: Number.isFinite(changed) ? changed : nowMs,
    });
  }
  return events;
}

/** Read the persisted log; corrupt or missing storage yields an empty one. */
export function loadLaneLog(storage: StorageLike): LaneLog {
  try {
    const raw = storage?.getItem(LANE_LOG_STORAGE_KEY);
    if (!raw) return { snapshot: null, events: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed)) return { snapshot: null, events: [] };
    const snapshot = Array.isArray(parsed.snapshot) ? parsed.snapshot.filter(isLaneRow) : null;
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isLaneEvent).slice(-LANE_LOG_MAX_EVENTS) : [];
    return { snapshot, events };
  } catch {
    return { snapshot: null, events: [] };
  }
}

/**
 * Record the snapshot just read and append the events it produced, capped at
 * LANE_LOG_MAX_EVENTS (newest kept). Returns the stored log so the caller can
 * render exactly what a reload will restore. Write failures are swallowed —
 * the thread degrades to session-only lines, it never breaks.
 */
export function appendLaneLog(storage: StorageLike, snapshot: readonly LaneHoldState[], events: readonly LaneEvent[]): LaneLog {
  const current = loadLaneLog(storage);
  const next: LaneLog = {
    snapshot: snapshot.map(row => ({ lane: row.lane, held: row.held, heldReason: row.heldReason ?? null, heldUntil: row.heldUntil ?? null, lastChange: row.lastChange ?? null })),
    events: [...current.events, ...events].slice(-LANE_LOG_MAX_EVENTS),
  };
  try {
    storage?.setItem(LANE_LOG_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return next;
}

const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
const etTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Same scrub as the fleet notifications: a reason never echoes a token-shaped run. */
const scrub = (v: string) => v.replace(/[A-Za-z0-9_-]{32,}/g, '…');

/** "codex-personal held: usage_limit, until Nov 7 15:16" / "codex-personal is running again". */
export function laneEventText(event: LaneEvent): string {
  if (event.kind === 'resumed') return `${scrub(event.lane)} is running again`;
  const until = event.until !== null && Number.isFinite(Date.parse(event.until))
    ? `, until ${etDay.format(new Date(event.until))} ${etTime.format(new Date(event.until))}` : '';
  return `${scrub(event.lane)} held${event.reason ? `: ${scrub(event.reason)}` : ''}${until}`;
}

/** Events as MergedLines: system rows with stable ids (lane + kind + atMs), oldest first. */
export function laneEventItems(events: readonly LaneEvent[]): MergedLine[] {
  return events.map(event => ({
    at: event.atMs,
    who: 'leader',
    source: 'system',
    text: laneEventText(event),
    id: `lane-${event.lane}-${event.kind}-${event.atMs}`,
    ack: null,
  }));
}
