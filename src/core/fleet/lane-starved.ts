/**
 * lane-starved.ts — RQ-STARVEN20MQ8: a lane is starved when it has free slots
 * and nothing ready to run on them. The dispatcher cannot launch what the
 * queue does not hold, so this state is silent unless someone looks for it.
 *
 * Pure derivation (`readStarved`) over what the lanes read already knows,
 * plus the one-line wording, the 30 minute Leader-chat notice and the small
 * state file that remembers when a lane first looked starved. Nothing here
 * writes to the router queue; the state file lives under the Leader root.
 */
import { join } from 'node:path';

export const FLEET_STARVED_SCHEMA = 'fleet.starved.v1' as const;
/** A lane starved this long earns a Leader-chat notice. */
export const STARVED_NOTICE_AFTER_MS = 30 * 60_000;
/** At most one notice per lane inside this window. */
export const STARVED_NOTICE_GAP_MS = 6 * 3_600_000;
export const STARVED_STATE_FILE = 'starved-lanes.json';
const STATE_MAX_BYTES = 16 * 1024;
const LANE_KEY = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** What the lanes read knows about one lane. `null` means the source was unreadable, never zero. */
export interface StarvedInput {
  lane: string;
  /** Slot target from a healthy lane-targets read (not the reserve floor, which is only a lower bound). */
  target: number | null;
  /** In-flight jobs. */
  running: number | null;
  /** READY rows routed to this lane. */
  ready: number | null;
  held: boolean;
  /** Credit is spent: nothing launched here would run. */
  drained: boolean;
}

export interface StarvedLane {
  /** Target minus running; 0 for a held lane; null when target or running is unknown. */
  free_slots: number | null;
  ready_rows: number | null;
  starved: boolean;
  /** ISO time the lane was first seen starved; null when not starved or not yet recorded. */
  starved_since: string | null;
  /** One plain line for a starved lane; null otherwise. */
  line: string | null;
}

export interface StarvedRead {
  lanes: Record<string, StarvedLane>;
  /** READY rows waiting on a held or drained pool that a starved lane could run instead (0 when no lane is starved). */
  waiting_elsewhere: number;
  /**
   * Lane-open READY rows — supply the shared market may place on any lane,
   * so a positive count keeps a free lane from reading as starved. Null when
   * the caller cannot say (the queue read did not report it).
   */
  open_rows: number | null;
}

export interface StarvedState {
  /** First time each lane was seen starved (ISO). */
  since: Record<string, string>;
  /** Last Leader-chat notice per lane (ms). */
  noticed: Record<string, number>;
}

export function starvedFor(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function starvedLine(lane: string, row: Pick<StarvedLane, 'free_slots' | 'ready_rows' | 'starved_since'>, nowMs: number): string {
  const since = row.starved_since === null ? NaN : Date.parse(row.starved_since);
  const age = Number.isFinite(since) && since <= nowMs ? ` for ${starvedFor(nowMs - since)}` : '';
  return `${lane}: ${plural(row.free_slots ?? 0, 'free slot', 'free slots')}, ${plural(row.ready_rows ?? 0, 'ready row', 'ready rows')}${age}; next step: add work for ${lane}`;
}

export function readStarved(
  inputs: readonly StarvedInput[],
  since: Readonly<Record<string, string>>,
  nowMs: number,
  openRows: number | null = null,
): StarvedRead {
  const lanes: Record<string, StarvedLane> = {};
  let waiting = 0;
  // Lane-open READY rows are open supply: the market may place them on any
  // lane, so a positive count means no lane is out of work.
  const open = typeof openRows === 'number' && Number.isSafeInteger(openRows) && openRows > 0;
  for (const input of inputs) {
    const free = input.target === null || input.running === null ? null : input.held ? 0 : Math.max(0, input.target - input.running);
    const starved = free !== null && free > 0 && input.ready === 0 && !open && !input.held && !input.drained;
    const recorded = since[input.lane];
    const at = starved && recorded !== undefined && Date.parse(recorded) <= nowMs ? recorded : null;
    const row: StarvedLane = { free_slots: free, ready_rows: input.ready, starved, starved_since: at, line: null };
    if (starved) row.line = starvedLine(input.lane, row, nowMs);
    lanes[input.lane] = row;
    if ((input.held || input.drained) && input.ready !== null) waiting += input.ready;
  }
  const any = Object.values(lanes).some(row => row.starved);
  const openCount = typeof openRows === 'number' && Number.isSafeInteger(openRows) && openRows >= 0 ? openRows : null;
  return { lanes, waiting_elsewhere: any ? waiting : 0, open_rows: openCount };
}

export function parseStarvedState(text: string | null): StarvedState {
  const state: StarvedState = { since: {}, noticed: {} };
  if (text === null) return state;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
    const { since, noticed } = raw as Record<string, unknown>;
    if (since && typeof since === 'object' && !Array.isArray(since)) {
      for (const [lane, at] of Object.entries(since)) if (LANE_KEY.test(lane) && typeof at === 'string' && Number.isFinite(Date.parse(at))) state.since[lane] = at;
    }
    if (noticed && typeof noticed === 'object' && !Array.isArray(noticed)) {
      for (const [lane, at] of Object.entries(noticed)) if (LANE_KEY.test(lane) && typeof at === 'number' && Number.isFinite(at)) state.noticed[lane] = at;
    }
  } catch { /* damaged state: start over, worst case one repeat notice */ }
  return state;
}

export function noticeText(line: string, waitingElsewhere: number): string {
  return waitingElsewhere > 0 ? `${line}. ${plural(waitingElsewhere, 'READY row is', 'READY rows are')} waiting on a held or drained pool and could run there instead.` : `${line}.`;
}

/**
 * Pure: the state after this reading (first-seen times kept for lanes still
 * starved, dropped for the rest) and the notices due now. A lane is noticed
 * once it has been starved 30 minutes, then not again for 6 hours.
 */
export function planStarvedNotices(read: StarvedRead, state: StarvedState, nowMs: number):
  { posts: { lane: string; text: string }[]; state: StarvedState } {
  const next: StarvedState = { since: {}, noticed: { ...state.noticed } };
  const posts: { lane: string; text: string }[] = [];
  for (const [lane, row] of Object.entries(read.lanes).sort(([a], [b]) => a.localeCompare(b))) {
    if (!row.starved) continue;
    const prior = state.since[lane];
    const first = prior !== undefined && Date.parse(prior) <= nowMs ? prior : new Date(nowMs).toISOString();
    next.since[lane] = first;
    if (nowMs - Date.parse(first) < STARVED_NOTICE_AFTER_MS) continue;
    const last = state.noticed[lane];
    if (typeof last === 'number' && nowMs >= last && nowMs - last < STARVED_NOTICE_GAP_MS) continue;
    posts.push({ lane, text: noticeText(starvedLine(lane, { ...row, starved_since: first }, nowMs), read.waiting_elsewhere) });
    next.noticed[lane] = nowMs;
  }
  return { posts, state: next };
}

export interface StarvedNoticeDeps {
  stateDir: string;
  /** Synchronous so the locked read-plan-post-write section never yields. Throws when the post fails. */
  post(text: string): void;
}

/** Record first-seen times and post each due notice. A failed post leaves that lane unnoticed, so the next tick retries. */
export async function postStarvedNotices(read: StarvedRead, deps: StarvedNoticeDeps, nowMs: number): Promise<string[]> {
  const [{ acquireLocalStoreLockWithOutcome, releaseLocalStoreLock }, prefs] = await Promise.all([
    import('./local-store-lock.js'), import('../verse/preferences.js'),
  ]);
  prefs.ensurePrivateDirectory(deps.stateDir);
  const path = join(deps.stateDir, STARVED_STATE_FILE);
  const lock = acquireLocalStoreLockWithOutcome(`${path}.lock`);
  if (lock.state !== 'acquired') return [];
  const sent: string[] = [];
  try {
    let state: StarvedState;
    try { state = parseStarvedState(prefs.readPrivateFileCapped(path, STATE_MAX_BYTES)?.text ?? null); } catch { state = { since: {}, noticed: {} }; }
    const plan = planStarvedNotices(read, state, nowMs);
    const next = { since: plan.state.since, noticed: { ...state.noticed } };
    for (const post of plan.posts) {
      try { deps.post(post.text); sent.push(post.text); next.noticed[post.lane] = nowMs; } catch { /* retried next tick */ }
    }
    const body = `${JSON.stringify(next)}\n`;
    if (body !== `${JSON.stringify(state)}\n`) prefs.writePrivateFileAtomic(path, body);
  } finally { releaseLocalStoreLock(lock.lock); }
  return sent;
}

/** Production wiring for the Leader tick: read the lanes, post due notices to the Leader thread. */
export async function runDefaultStarvedNotices(): Promise<string[]> {
  const [{ postLeaderMessage }, memo, { getFleetLaneSnapshot }] = await Promise.all([
    import('../vision/leader-thread.js'), import('../vision/leader-memo.js'), import('./lane-console.js'),
  ]);
  const snapshot = await getFleetLaneSnapshot({ starvedStateDir: memo.leaderRoot() });
  return postStarvedNotices(snapshot.starved, {
    stateDir: memo.leaderRoot(),
    post: text => { postLeaderMessage({ channel: 'telegram', kind: 'update', text }); },
  }, Date.parse(snapshot.generatedAt));
}
