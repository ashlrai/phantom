/**
 * routes/verse/session-wall/wall-order.ts: the order the Conversations pane
 * puts its sessions in, on the wall and in the list beside an open
 * conversation.
 *
 * - Fleet order is the read's own: the Leader, then each worker with its
 *   helpers.
 * - Latest first is how a messaging app lists its threads: the session that
 *   spoke most recently leads. A session with no known time goes last, never
 *   first as if it had just spoken.
 * - By lane and By repo put the sessions under one heading per lane or repo,
 *   named ones A to Z and "unknown" last; a helper stands with its worker.
 *
 * The Leader stays first in every order: it is the one Mason talks to.
 * Nothing is asked of the server and no session is added or dropped; only the
 * order changes. The choice is kept in this browser's storage, so a reload
 * opens the wall the way it was left.
 */
import { STATE_WORD, stateCounts, WALL_STATES, type WallEntry } from './session-wall-model.js';

export const WALL_ORDERS = ['fleet', 'latest', 'lane', 'repo'] as const;
export type WallOrder = (typeof WALL_ORDERS)[number];
export const ORDER_WORD: Readonly<Record<WallOrder, string>> = { fleet: 'Fleet order', latest: 'Latest first', lane: 'By lane', repo: 'By repo' };
/** What an order other than the fleet's does, for the line under the bar. */
export const ORDER_NOTE: Readonly<Record<WallOrder, string | null>> = {
  fleet: null,
  latest: 'Latest first: the session that spoke most recently leads, one with no known time goes last',
  lane: 'By lane: named lanes A to Z, a helper with its worker',
  repo: 'By repo: named repos A to Z, a helper with its worker',
};
export const WALL_ORDER_KEY = 'phantom.sessionWallOrder.v1';

export const isWallOrder = (v: unknown): v is WallOrder => WALL_ORDERS.includes(v as WallOrder);
/** The order after this one, round and round (the O key). */
export const nextOrder = (order: WallOrder): WallOrder => WALL_ORDERS[(WALL_ORDERS.indexOf(order) + 1) % WALL_ORDERS.length]!;

/** The Leader's own group; a key no lane or repo can be. */
const LEADER = '\u0000leader';
const UNKNOWN = 'unknown';

/**
 * The group each entry falls in: its lane or repo, its worker's when it is a helper whose worker is in the read, the Leader's own for the Leader.
 * `among` is every session the read holds, so a helper stays under its worker's heading while a filter hides the worker.
 */
function groupKeys(entries: readonly WallEntry[], field: 'lane' | 'repo', among: readonly WallEntry[]): string[] {
  const byId = new Map(among.map(entry => [entry.session.id, entry]));
  return entries.map(entry => {
    const { session } = entry;
    const owner = session.kind === 'subagent' && session.parentId !== null ? byId.get(session.parentId)?.session ?? session : session;
    return owner.kind === 'leader' ? LEADER : owner[field];
  });
}

const groupRank = (key: string) => (key === LEADER ? 0 : key === UNKNOWN ? 2 : 1);
const byGroup = (a: string, b: string) => groupRank(a) - groupRank(b) || a.localeCompare(b);
/** Unknown sorts after every known age. */
const age = (entry: WallEntry) => entry.session.lastMessageAgeSeconds ?? Number.POSITIVE_INFINITY;

/** The same sessions in the order asked for. Ties keep the read's order, and the fleet's order is the array it was given. */
export function arrangeEntries(entries: readonly WallEntry[], order: WallOrder, among: readonly WallEntry[] = entries): readonly WallEntry[] {
  if (order === 'fleet' || entries.length < 2) return entries;
  if (order === 'latest') {
    const lead = (entry: WallEntry) => (entry.session.kind === 'leader' ? 0 : 1);
    return [...entries].sort((a, b) => lead(a) - lead(b) || (age(a) === age(b) ? 0 : age(a) < age(b) ? -1 : 1));
  }
  const keys = groupKeys(entries, order, among);
  return entries.map((entry, at) => ({ entry, key: keys[at]! })).sort((a, b) => byGroup(a.key, b.key)).map(({ entry }) => entry);
}

export interface WallGroupHead {
  /** The lane or repo as the read names it; null for the Leader's group and for "unknown". */
  name: string | null;
  label: string;
  /** How many sessions stand under the heading, and in which states: "3 sessions: 2 running, 1 quiet". */
  count: string;
}

/**
 * The headings of a wall arranged by lane or repo, each keyed by the id of the
 * first session under it. Empty for the other orders. Counted from the entries
 * given, so a heading never promises a card that is not under it.
 */
export function groupHeads(entries: readonly WallEntry[], order: WallOrder, among: readonly WallEntry[] = entries): ReadonlyMap<string, WallGroupHead> {
  const heads = new Map<string, WallGroupHead>();
  if (order !== 'lane' && order !== 'repo') return heads;
  const keys = groupKeys(entries, order, among);
  for (let from = 0; from < entries.length;) {
    const key = keys[from]!;
    let to = from + 1;
    while (to < entries.length && keys[to] === key) to += 1;
    const counts = stateCounts(entries.slice(from, to)), size = to - from;
    const states = WALL_STATES.filter(state => counts[state] > 0).map(state => `${counts[state]} ${STATE_WORD[state]}`).join(', ');
    heads.set(entries[from]!.session.id, {
      name: key === LEADER || key === UNKNOWN ? null : key,
      label: key === LEADER ? 'Leader' : key === UNKNOWN ? `${order} unknown` : key,
      count: `${size} session${size === 1 ? '' : 's'}: ${states}`,
    });
    from = to;
  }
  return heads;
}

function orderStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The kept order; anything unreadable is the fleet's. */
export function loadWallOrder(storage: Storage | null = orderStorage()): WallOrder {
  try { const kept = storage?.getItem(WALL_ORDER_KEY); return isWallOrder(kept) ? kept : 'fleet'; } catch { return 'fleet'; }
}

/** Keeps a chosen order and forgets the fleet's. False when it could not be written, so it lasts only while the pane is open. */
export function saveWallOrder(order: WallOrder, storage: Storage | null = orderStorage()): boolean {
  if (!storage) return false;
  try {
    if (order === 'fleet') storage.removeItem(WALL_ORDER_KEY);
    else storage.setItem(WALL_ORDER_KEY, order);
    return true;
  } catch {
    return false;
  }
}

export function forgetWallOrder(storage: Storage | null = orderStorage()): void {
  try { storage?.removeItem(WALL_ORDER_KEY); } catch { /* nothing was kept */ }
}
