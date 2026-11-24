/**
 * GET /api/verse/leader/health: the fleet.leader-health.v1 document that
 * `phm fleet leader-health --json` prints (cli/fleet-leader-health.ts builds
 * it): leader passes failed in a row, hours since one succeeded, the last bet
 * and the first line of the failing pass's output as the cause.
 *
 * Read only, and it needs a current read session like the rest of the Leader
 * reads. The builder walks the whole dispatch log, so callers share one
 * reading for 15 seconds. Absent evidence stays null in the document, never 0.
 *
 *   200 the document · 401 no read session · 405 not GET · 503 the read threw
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFleetLeaderHealth, type FleetLeaderHealth } from '../../cli/fleet-leader-health.js';
import { sendJson } from '../web/api.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_LEADER_HEALTH_PATH = '/api/verse/leader/health';
export const LEADER_HEALTH_MIN_INTERVAL_MS = 15_000;

export type LeaderHealthRoute = (ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string) => Promise<boolean>;

export function createLeaderHealthRoute(
  read: () => Promise<FleetLeaderHealth> = () => readFleetLeaderHealth(),
  now: () => number = Date.now,
): LeaderHealthRoute {
  let held: { at: number; reading: Promise<FleetLeaderHealth> } | null = null;
  return async (ctx, _req, res, method) => {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    if (held === null || now() - held.at >= LEADER_HEALTH_MIN_INTERVAL_MS) held = { at: now(), reading: read() };
    const mine = held;
    try {
      sendJson(res, 200, await mine.reading);
    } catch {
      // A failed reading is not kept for the next caller.
      if (held === mine) held = null;
      sendJson(res, 503, { error: 'leader-health-unavailable' });
    }
    return true;
  };
}

export const handleLeaderHealth = createLeaderHealthRoute();
