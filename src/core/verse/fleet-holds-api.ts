/**
 * Fleet holds API — releasing a stale lane hold from Phantom. Mounted by
 * verse-api.ts (A10 id `fleet-holds`):
 *
 *   GET  /api/verse/fleet/control/holds → LaneTargetsV1 — the same read the
 *                                       lanes route serves, so a client can
 *                                       read and write through one path
 *   POST /api/verse/fleet/control/holds → {lane, action:'release', reason?} → LaneTargetsV1
 *
 * The path sits inside the fleet-control workbench family's /api/verse/fleet/
 * control prefix, so dispatchWorkbenchModules lets exactly this path fall
 * through to the mounted modules. The operation lives in
 * core/fleet/runs-lane-hold.ts; this file is the HTTP edge: query/body
 * validation, the dispatch + mutation-token gate on POST re-checked here
 * like every Verse mutation (agents and MCP clients cannot reach it), and
 * sendJson → sanitizePublicJson on the way out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { VERSE_FLEET_CONTROL_HOLDS_PATH } from '../fleet/runs-lane-hold.js';

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function noQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key}`);
    return false;
  }
  return true;
}

async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** One action at a time: a double-click must not interleave two rewrites. */
let actionInFlight: Promise<unknown> | null = null;

export const handleFleetHoldsApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== VERSE_FLEET_CONTROL_HOLDS_PATH) return false;
  try {
    const { readLaneTargets } = await import('../fleet/runs-lane-targets.js');
    const { releaseLaneHold, parseLaneHoldAction, LaneHoldError } = await import('../fleet/runs-lane-hold.js');
    if (method === 'GET') {
      if (noQuery(req, res)) sendJson(res, 200, await readLaneTargets());
    } else if (method === 'POST') {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      const action = parseLaneHoldAction(body);
      if (!action) { sendInvalid(res, 'invalid lane hold action'); return true; }
      if (actionInFlight) {
        sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
        return true;
      }
      const run = releaseLaneHold(action.lane, { reason: action.reason, changedBy: 'Phantom desktop' });
      actionInFlight = run;
      try { sendJson(res, 200, await run); }
      catch (error) {
        if (error instanceof LaneHoldError) sendJson(res, error.status, { code: error.code, error: error.message });
        else throw error;
      } finally { actionInFlight = null; }
    } else sendJson(res, 405, { error: 'method not allowed' });
  } catch {
    sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
  }
  return true;
};
