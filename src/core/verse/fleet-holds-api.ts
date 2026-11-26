/**
 * Fleet controls API — holds release and stray stop from Phantom. Mounted by
 * verse-api.ts (A10 id `fleet-holds`):
 *
 *   GET  /api/verse/fleet/control/holds → LaneTargetsV1 — the same read the
 *                                       lanes route serves, so a client can
 *                                       read and write through one path
 *   POST /api/verse/fleet/control/holds → {lane, action:'release', reason?} → LaneTargetsV1
 *                                       → {lane, action:'hold', minutes, reason?} → LaneTargetsV1
 *   POST /api/verse/fleet/control/stray-slots → verified SIGTERM + audit + refreshed report
 *
 * The path sits inside the fleet-control workbench family's /api/verse/fleet/
 * control prefix, so dispatchWorkbenchModules lets exactly this path fall
 * through to the mounted modules. The operation lives in
 * core/fleet/runs-lane-hold.ts; this file is the HTTP edge: query/body
 * validation, the dispatch + mutation-token gate on POST re-checked here
 * like every Verse mutation (agents and MCP clients cannot reach it), and
 * sendJson → sanitizePublicJson on the way out.
 */
import { parseStrayStopAction, stopStray, StrayStopError, VERSE_FLEET_CONTROL_STRAY_STOP_PATH } from '../fleet/stray-stop.js';
import { hasNoQuery, readMutationBody, sendInvalid } from './api-http.js';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api-http-helpers.js';
import { VERSE_FLEET_CONTROL_HOLDS_PATH } from '../fleet/runs-lane-hold.js';

/** One action at a time: a double-click must not interleave two rewrites. */
let actionInFlight: Promise<unknown> | null = null;

export const handleFleetHoldsApi: ApiModule = async (ctx, req, res, path, method) => {
  const strayStop = path === VERSE_FLEET_CONTROL_STRAY_STOP_PATH && method === 'POST';
  if (!strayStop && path !== VERSE_FLEET_CONTROL_HOLDS_PATH) return false;
  if (strayStop) {
    try {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      const action = parseStrayStopAction(body);
      if (!action) { sendInvalid(res, 'invalid stray stop action'); return true; }
      if (actionInFlight) {
        sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
        return true;
      }
      const run = stopStray(action);
      actionInFlight = run;
      try { sendJson(res, 200, await run); }
      finally { actionInFlight = null; }
    } catch (error) {
      if (error instanceof StrayStopError) sendJson(res, error.status, { code: error.code, error: error.message });
      else sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
    }
    return true;
  }
  try {
    const { readLaneTargets } = await import('../fleet/runs-lane-targets.js');
    const { releaseLaneHold, parseLaneHoldAction, LaneHoldError } = await import('../fleet/runs-lane-hold.js');
    const { placeLaneHold } = await import('../fleet/runs-lane-hold-place.js');
    if (method === 'GET') {
      if (hasNoQuery(req, res)) sendJson(res, 200, await readLaneTargets());
    } else if (method === 'POST') {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      const action = parseLaneHoldAction(body);
      if (!action) { sendInvalid(res, 'invalid lane hold action'); return true; }
      if (actionInFlight) {
        sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
        return true;
      }
      const run = action.action === 'hold'
        ? placeLaneHold(action.lane, { minutes: action.minutes, reason: action.reason, changedBy: 'Phantom desktop' })
        : releaseLaneHold(action.lane, { reason: action.reason, changedBy: 'Phantom desktop' });
      actionInFlight = run;
      try { sendJson(res, 200, await run); }
      catch (error) {
        // An unknown lane is a bad request on the hold verb (400); release
        // keeps its existing 422 contract.
        if (error instanceof LaneHoldError) sendJson(res, action.action === 'hold' && error.code === 'unknown-lane' ? 400 : error.status, { code: error.code, error: error.message });
        else throw error;
      } finally { actionInFlight = null; }
    } else sendJson(res, 405, { error: 'method not allowed' });
  } catch {
    sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
  }
  return true;
};
