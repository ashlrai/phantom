/**
 * One Leader-chat notice per lane per day when a lane has held 3 or more
 * launches inside an hour. Same claim-then-record shape as usage/plan-pace.ts:
 * the Leader tick calls it, nothing new runs in the background.
 */
import { join } from 'node:path';
import { HELD_NOTICE_THRESHOLD, type LaneHeld } from './lane-held.js';

const DAY_MS = 24 * 3_600_000;
const STATE_MAX_BYTES = 16 * 1024;
const LANE_KEY = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Last notice time (ms) per lane. */
export type HeldNoticeState = Record<string, number>;

export function heldNoticeText(lane: string, held: LaneHeld): string {
  return `The ${lane} lane has held ${held.launches_held_1h} launches in the last hour: ${held.reason}. Next step: ${held.next_step}.`;
}

/** Pure: lines to post now and the state once they are posted. */
export function planHeldNotices(lanes: ReadonlyMap<string, LaneHeld>, state: HeldNoticeState, nowMs: number):
  { posts: { lane: string; text: string }[]; state: HeldNoticeState } {
  const next: HeldNoticeState = { ...state };
  const posts: { lane: string; text: string }[] = [];
  for (const [lane, held] of [...lanes].sort(([a], [b]) => a.localeCompare(b))) {
    if (held.launches_held_1h < HELD_NOTICE_THRESHOLD) continue;
    const last = state[lane];
    if (typeof last === 'number' && nowMs >= last && nowMs - last < DAY_MS) continue;
    posts.push({ lane, text: heldNoticeText(lane, held) });
    next[lane] = nowMs;
  }
  return { posts, state: next };
}

export function parseHeldNoticeState(text: string | null): HeldNoticeState {
  const out: HeldNoticeState = {};
  if (text === null) return out;
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [lane, at] of Object.entries(raw)) if (typeof at === 'number' && Number.isFinite(at) && LANE_KEY.test(lane)) out[lane] = at;
    }
  } catch { /* damaged state: start over, worst case one repeat line */ }
  return out;
}

export interface HeldNoticeDeps {
  stateDir: string;
  /** Synchronous so the locked read-plan-post-write section never yields. Throws when the post fails. */
  post(text: string): void;
}

/** Post each due line, then record the time. A failed post leaves that lane unrecorded, so the next tick retries. */
export async function postHeldNotices(lanes: ReadonlyMap<string, LaneHeld>, deps: HeldNoticeDeps, nowMs: number): Promise<string[]> {
  if (![...lanes.values()].some(held => held.launches_held_1h >= HELD_NOTICE_THRESHOLD)) return [];
  const [{ acquireLocalStoreLockWithOutcome, releaseLocalStoreLock }, prefs] = await Promise.all([
    import('./local-store-lock.js'), import('../verse/preferences.js'),
  ]);
  prefs.ensurePrivateDirectory(deps.stateDir);
  const path = join(deps.stateDir, 'held-lane-notices.json');
  const lock = acquireLocalStoreLockWithOutcome(`${path}.lock`);
  if (lock.state !== 'acquired') return [];
  const sent: string[] = [];
  try {
    const state = parseHeldNoticeState(prefs.readPrivateFileCapped(path, STATE_MAX_BYTES)?.text ?? null);
    const plan = planHeldNotices(lanes, state, nowMs);
    const next = { ...state };
    for (const post of plan.posts) {
      try { deps.post(post.text); sent.push(post.text); next[post.lane] = nowMs; } catch { /* retried next tick */ }
    }
    if (sent.length) prefs.writePrivateFileAtomic(path, `${JSON.stringify(next)}\n`);
  } finally { releaseLocalStoreLock(lock.lock); }
  return sent;
}

/** Production wiring for the Leader tick: read the lanes, post due lines to the Leader thread. */
export async function runDefaultHeldLaneNotices(): Promise<string[]> {
  const [{ postLeaderMessage }, memo, { getFleetLaneSnapshot }] = await Promise.all([
    import('../vision/leader-thread.js'), import('../vision/leader-memo.js'), import('./lane-console.js'),
  ]);
  const snapshot = await getFleetLaneSnapshot();
  const held = new Map(snapshot.lanes.flatMap(lane => lane.held ? [[lane.lane, lane.held] as const] : []));
  return postHeldNotices(held, {
    stateDir: memo.leaderRoot(),
    post: text => { postLeaderMessage({ channel: 'telegram', kind: 'update', text }); },
  }, Date.parse(snapshot.generatedAt));
}
