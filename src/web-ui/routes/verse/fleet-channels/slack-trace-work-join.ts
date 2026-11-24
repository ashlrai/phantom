/**
 * Pure client-side join of a Slack trace row to the work board
 * (RQ-PHX-SLACKTRACEWORKSTATE453C). No React, no I/O, never throws.
 * Absence is only claimed when the board is readable and not truncated.
 */
export type SlackWorkState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';

export type SlackWorkCell =
  | { kind: 'item'; state: SlackWorkState; owner: string | null; id: string }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }
  | { kind: 'unknown' };

const STATES: readonly string[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
const UNKNOWN: SlackWorkCell = { kind: 'unknown' };

// Mirror the Slack identity grammar locally; browser code cannot import the backend.
const CHANNEL = /^[CDG][A-Z0-9]{2,32}$/;
const TEAM = /^[TE][A-Z0-9]{2,32}$/;
const TS = /^\d{1,20}\.\d{1,10}$/;

function refMatches(ref: string, channelId: string, threadTs: string): boolean {
  if (ref.length > 128) return false;
  const parts = ref.startsWith('slack:') ? ref.slice(6).split(':') : ref.split('/');
  return parts.length === 3 && TEAM.test(parts[0]!) && CHANNEL.test(parts[1]!) &&
    TS.test(parts[2]!) && parts[1] === channelId && parts[2] === threadTs;
}

export function joinSlackWork(threadTs: string, channelId: string | undefined, board: unknown): SlackWorkCell {
  if (typeof channelId !== 'string' || !CHANNEL.test(channelId)) return UNKNOWN;
  if (board === null || typeof board !== 'object') return UNKNOWN;
  const b = board as Record<string, unknown>;
  if (b['inbox'] !== 'ok' || !Array.isArray(b['items'])) return UNKNOWN;
  const matches: Array<{ state: SlackWorkState; owner: string | null; id: string }> = [];
  if (threadTs !== '') {
    for (const raw of b['items'] as unknown[]) {
      if (raw === null || typeof raw !== 'object') continue;
      const it = raw as Record<string, unknown>;
      if (it['channel'] !== 'slack' || typeof it['channelRef'] !== 'string') continue;
      if (!refMatches(it['channelRef'], channelId, threadTs)) continue;
      const state = it['state'];
      if (typeof state !== 'string' || !STATES.includes(state)) continue;
      const owner = typeof it['owner'] === 'string' && it['owner'] !== '' ? it['owner'] : null;
      matches.push({ state: state as SlackWorkState, owner, id: typeof it['id'] === 'string' ? it['id'] : '' });
    }
  }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length };
  if (matches.length === 1) return { kind: 'item', ...matches[0]! };
  return b['truncated'] === true ? UNKNOWN : { kind: 'none' };
}
