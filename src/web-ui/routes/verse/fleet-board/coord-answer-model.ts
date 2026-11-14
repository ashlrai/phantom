/**
 * routes/verse/fleet-board/coord-answer-model.ts — the pure derivation behind
 * CoordAnswerStrip (RQ-PHX-COORDANSWERSTRIP322): Mason/Dot's Nov13 13:13 ET
 * order as one strip — sanitized runtime identity, a fresh claims read, a
 * LIVE bridge to Dot, one task with a named owner/claim. REACHABLE only when
 * the runtime fleet state is not stale, the work-board inbox is 'ok' and at
 * least one channel is LIVE. Unknown inputs print 'unknown', never 0 / fake OK.
 */
import { formatRelative } from '../autonomy/format.js';
import { formatAge, type RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import type { ChannelHealthRow, ChannelHealthView } from '../fleet-channels/channel-health-model.js';

export type CoordVerdict = 'REACHABLE' | 'BLOCKED' | 'LOADING';

export interface CoordAnswerRow {
  label: string;
  value: string;
  /** true = confirmed good, false = confirmed failed, 'unknown' = unmeasurable. */
  ok: boolean | 'unknown';
}

export interface CoordExampleTask { id: string; state: string; channelRef: string | null; }

export interface CoordAnswer {
  verdict: CoordVerdict;
  rows: CoordAnswerRow[];
  /** Plain-words reasons the answer is not fully REACHABLE. */
  missing: string[];
  exampleTask: CoordExampleTask | null;
}

/** The work-board payload as the strip reads it: every field optional — the
 * route is absent on older builds and pre-claim payloads lack the
 * `owner`/`claimReceipt` keys entirely. `WorkBoardResponse` (work-board-section)
 * is assignable to this. */
export interface CoordBoardItem {
  id?: string;
  state?: string;
  channelRef?: string | null;
  receivedAt?: string;
  owner?: string | null;
  claimReceipt?: string | null;
}
export interface CoordBoardView { inbox?: string; items?: CoordBoardItem[]; asOf?: string; }

export interface CoordAnswerInput {
  runtime: RuntimeIdentityView | null | undefined;
  channels: ChannelHealthView | undefined;
  board: CoordBoardView | null | undefined;
  now: number;
}

function channelValue(ch: ChannelHealthRow, now: number): string {
  if (ch.state === 'LIVE') return ch.lastReplyAt ? `LIVE · last reply ${formatRelative(ch.lastReplyAt, now)}` : 'LIVE · no reply yet';
  return ch.missing.length > 0 ? `${ch.state} · missing ${ch.missing.join(', ')}` : ch.state;
}

/** Newest-first by receivedAt; unparseable stamps sort oldest. */
function newestFirst(a: CoordBoardItem, b: CoordBoardItem): number {
  const rank = (it: CoordBoardItem) => {
    const t = Date.parse(it.receivedAt ?? '');
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return rank(b) - rank(a);
}

export function deriveCoordAnswer({ runtime, channels, board, now }: CoordAnswerInput): CoordAnswer {
  const missing: string[] = [];
  const rows: CoordAnswerRow[] = [];
  const row = (label: string, value: string, ok: boolean | 'unknown') => rows.push({ label, value, ok });

  let runtimeFresh = false;
  if (runtime === undefined) row('Runtime', 'unknown', 'unknown');
  else if (runtime === null) {
    row('Runtime', 'unknown · not on this build', 'unknown');
    missing.push('runtime identity not available on this build');
  } else {
    const fs = runtime.fleetState;
    const staleness = fs.stale === true ? ' · stale' : fs.stale === 'unknown' ? ' · staleness unknown' : '';
    row('Runtime',
      `${runtime.host} · ${runtime.installedVersion} · fleet state ${formatAge(fs.ageSeconds)}${staleness}`,
      fs.stale === false ? true : fs.stale === true ? false : 'unknown');
    if (fs.stale === true) missing.push('fleet state is stale');
    else if (fs.stale === 'unknown') missing.push('fleet state staleness is unknown');
    runtimeFresh = fs.stale === false;
  }

  let inboxOk = false;
  if (board === undefined) row('Claims/work read', 'unknown', 'unknown');
  else if (board === null) {
    row('Claims/work read', 'not on this build', false);
    missing.push('work board not available on this Phantom build');
  } else if (board.inbox === 'ok') {
    inboxOk = true;
    row('Claims/work read', `inbox ok · as of ${formatRelative(board.asOf ?? null, now)}`, true);
  } else if (board.inbox === 'unavailable') {
    row('Claims/work read', 'inbox unreadable', false);
    missing.push('work-board inbox unreadable');
  } else {
    row('Claims/work read', 'unknown', 'unknown');
    missing.push('work-board inbox state unknown');
  }

  let liveChannel = false;
  const channelRow = (key: ChannelHealthRow['channel'], label: string): void => {
    if (channels === undefined) { row(label, 'unknown', 'unknown'); return; }
    if (!channels.available) { row(label, 'unavailable', 'unknown'); return; }
    const ch = channels.channels.find((c) => c.channel === key);
    if (ch === undefined) {
      row(label, 'unreported', 'unknown');
      missing.push(`${label} not reported`);
    } else if (ch.state === 'LIVE') {
      liveChannel = true;
      row(label, channelValue(ch, now), true);
    } else {
      row(label, channelValue(ch, now), ch.state === 'UNKNOWN' ? 'unknown' : false);
      missing.push(`${label} ${channelValue(ch, now)}`);
    }
  };
  channelRow('slack', 'Slack bridge');
  channelRow('imessage', 'iMessage bridge');
  if (channels !== undefined && !channels.available) missing.push('channel health unavailable — no bridge confirmed LIVE');

  let exampleTask: CoordExampleTask | null = null;
  if (board === undefined) row('Example task', 'unknown', 'unknown');
  else if (board === null) row('Example task', 'unavailable', 'unknown');
  else {
    const items = Array.isArray(board.items) ? board.items : [];
    const active = items.filter((i) => i.state === 'RUNNING' || i.state === 'VERIFIED').sort(newestFirst);
    const pick = active[0] ?? items.filter((i) => i.state === 'ASSIGNED').sort(newestFirst)[0] ?? null;
    if (pick === null || typeof pick.id !== 'string' || pick.id === '') {
      row('Example task', 'none', 'unknown');
      missing.push('no RUNNING, VERIFIED or ASSIGNED task on the board');
    } else {
      const ref = pick.channelRef ?? 'no channel ref';
      exampleTask = { id: pick.id, state: pick.state ?? 'unknown', channelRef: pick.channelRef ?? null };
      // The server shape (src/core/comms/work-board.ts) emits owner and
      // claimReceipt on every item; an older payload lacks the keys entirely.
      const carriesClaim = 'owner' in pick || 'claimReceipt' in pick;
      const owner = typeof pick.owner === 'string' && pick.owner !== '' ? pick.owner : null;
      const receipt = typeof pick.claimReceipt === 'string' && pick.claimReceipt !== '' ? pick.claimReceipt : null;
      if (!carriesClaim) {
        row('Example task', `${pick.id} · ${pick.state} · ${ref}`, 'unknown');
        missing.push('owner/claim not in web payload');
      } else if (owner !== null && receipt !== null) {
        row('Example task', `${pick.id} · ${pick.state} · owner ${owner} · ${ref}`, true);
      } else {
        row('Example task', `${pick.id} · ${pick.state} · no named owner/claim · ${ref}`, false);
        missing.push(`example task ${pick.id} has no named owner/claim`);
      }
    }
  }

  const loading = runtime === undefined || channels === undefined || board === undefined;
  const verdict: CoordVerdict = loading ? 'LOADING' : runtimeFresh && inboxOk && liveChannel ? 'REACHABLE' : 'BLOCKED';
  return { verdict, rows, missing, exampleTask };
}
