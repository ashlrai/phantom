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

/** Last segment after the final `/` or `:`; covers `T/C/ts` and `slack:T:C:ts`. */
function refThread(ref: string): string {
  return ref.slice(Math.max(ref.lastIndexOf('/'), ref.lastIndexOf(':')) + 1);
}

export function joinSlackWork(threadTs: string, board: unknown): SlackWorkCell {
  if (board === null || typeof board !== 'object') return UNKNOWN;
  const b = board as Record<string, unknown>;
  if (b['inbox'] !== 'ok' || !Array.isArray(b['items'])) return UNKNOWN;
  const matches: Array<{ state: SlackWorkState; owner: string | null; id: string }> = [];
  if (threadTs !== '') {
    for (const raw of b['items'] as unknown[]) {
      if (raw === null || typeof raw !== 'object') continue;
      const it = raw as Record<string, unknown>;
      if (it['channel'] !== 'slack' || typeof it['channelRef'] !== 'string') continue;
      if (refThread(it['channelRef']) !== threadTs) continue;
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
