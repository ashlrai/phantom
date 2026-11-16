/** Did the asker hear back? Joins an inbox order's `[leader-network:<64 hex>]`
 * request id (mason-inbox.ts) to the leader's `routes[requestId]` receipt
 * (agents/leader-network.ts, same id) and reports only whether the same-thread
 * reply was delivered, attempted (outcome unknown) or never sent. Read-only,
 * size-capped and never throws; no reply text, channel, owner id or path ever
 * leaves this module. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';

export type ThreadReply = 'delivered' | 'attempted' | 'none' | 'unknown';
export interface RouteReplyFacts { delivered: boolean; attempted: boolean }

/** Matches the leader's own MAX_RECORD_BYTES write cap. */
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
const REQUEST_ID = /^[a-f0-9]{64}$/;

export function threadReplyOf(requestId: string | undefined, routes: ReadonlyMap<string, RouteReplyFacts> | null): ThreadReply {
  if (requestId === undefined || routes === null) return 'unknown';
  const reply = routes.get(requestId);
  if (reply === undefined) return 'none';
  if (reply.delivered) return 'delivered';
  if (reply.attempted) return 'attempted';
  return 'none';
}

export function readRouteReplyFacts(opts: { runsDir?: string; maxBytes?: number } = {}): Map<string, RouteReplyFacts> | null {
  try {
    const leaderDir = join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'leader');
    const max = opts.maxBytes ?? MAX_STATE_BYTES;
    const result = readStableRegularFile(join(leaderDir, 'network-state.json'), { anchorPath: leaderDir, maxFileBytes: max, remainingBytes: max });
    if (!result.ok) return null;
    const state = JSON.parse(result.text) as { version?: unknown; routes?: unknown } | null;
    if (!state || typeof state !== 'object' || state.version !== 1) return null;
    const routes = state.routes;
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return null;
    const out = new Map<string, RouteReplyFacts>();
    for (const [id, route] of Object.entries(routes as Record<string, unknown>)) {
      if (!REQUEST_ID.test(id) || !route || typeof route !== 'object') return null;
      const reply = (route as { reply?: unknown }).reply;
      if (reply === undefined) { out.set(id, { delivered: false, attempted: false }); continue; }
      if (!reply || typeof reply !== 'object') return null;
      const { delivered, attempted } = reply as { delivered?: unknown; attempted?: unknown };
      if (typeof delivered !== 'boolean' || typeof attempted !== 'boolean') return null;
      out.set(id, { delivered, attempted });
    }
    return out;
  } catch {
    return null;
  }
}
