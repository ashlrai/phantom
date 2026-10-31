/**
 * Fleet control API — 3.15, the Fleet tab's control surface. Mounted by C0 in
 * verse-api.ts (WORKBENCH_ROUTE_FAMILIES id `fleet-control`).
 *
 *   GET  /api/verse/fleet/control               → FleetControlStateV1
 *   GET  /api/verse/fleet/control/queue         → FleetControlQueueV1
 *   GET  /api/verse/fleet/control/runs/<id>/log → FleetRunLogV1
 *   POST /api/verse/fleet/control               → one FleetControlAction → FleetControlActionResultV1
 *
 * The operations live in core/fleet/fleet-control.ts (each reuses the one
 * path it already had: daemon/pause.ts, authority/clamp.ts Stop / clear-stop,
 * the switch, fleet/run-cancel.ts, fleet/task-source.ts). This file is the
 * HTTP edge: query/body validation, the dispatch + mutation-token gate on
 * every POST (re-checked here, like every Verse module — agents and MCP
 * clients cannot reach it), and sendJson → sanitizePublicJson on the way out.
 *
 * What this route does NOT do: start or stop the resident launchd service,
 * or install the custody helper. Those run in the DESKTOP app's native layer
 * behind a native confirm dialog (desktop/src-tauri/src/fleet_ops.rs); Start
 * answers `needs: resident-start` and the page hands that to native. A server
 * route that any holder of the mutation token could call must never be able
 * to (re)start the resident daemon.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RemoteDeviceStore } from '../web/remote-device-store.js';
import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import {
  FleetControlError,
  applyFleetControlAction,
  defaultFleetControlDeps,
  parseFleetControlAction,
  preloadFleetControlModules,
  readFleetControlQueue,
  readFleetControlState,
  readFleetRunLog,
  type FleetControlDeps,
} from '../fleet/fleet-control.js';
import { isRunId } from '../fleet/run-cancel.js';
import {
  VERSE_FLEET_CONTROL_PATH,
  VERSE_FLEET_CONTROL_QUEUE_PATH,
  VERSE_FLEET_CONTROL_RUNS_PREFIX,
} from '../fleet/fleet-control-types.js';

type ControlDeps = FleetControlDeps & { remoteDevices?: () => Pick<RemoteDeviceStore, 'list'> };
let deps: ControlDeps | null = null;

/** Test seam: replace the dependencies (null restores the defaults). */
export function setFleetControlDepsForTest(next: ControlDeps | null): void {
  deps = next;
}

async function currentDeps(): Promise<FleetControlDeps> {
  if (deps) return deps;
  await preloadFleetControlModules();
  deps = defaultFleetControlDeps();
  return deps;
}

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

/** One action at a time: a double-click must not interleave Start with Stop. */
let actionInFlight: Promise<unknown> | null = null;

export const handleFleetControlApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path === '/api/verse/fleet/control/remote-devices') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!noQuery(req, res)) return true;
    try {
      const { createRemoteDeviceStore } = await import('../web/remote-device-store.js');
      let sourceState: 'healthy' | 'missing' = 'healthy';
      const store = deps?.remoteDevices?.() ?? createRemoteDeviceStore();
      // list() preserves the registry's privacy and validation checks, even
      // when it is empty. Only ENOENT is a missing source.
      const devices = store.list();
      if (!deps?.remoteDevices) {
        const { stat } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { defaultVerseRoot } = await import('./preferences.js');
        try { await stat(join(defaultVerseRoot(), 'remote-devices.json')); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          sourceState = 'missing';
        }
      }
      sendJson(res, 200, {
        v: 1, generatedAt: new Date().toISOString(), sourceState,
        devices: sourceState === 'missing' ? [] : devices.map(d => ({
          id: d.id, label: d.label.slice(0, 200), email: d.email.slice(0, 200), subject: d.subject.slice(0, 200),
          act: d.scopes.act, createdAt: new Date(d.createdAt).toISOString(),
          lastUsedAt: d.lastUsedAt === null ? null : new Date(d.lastUsedAt).toISOString(),
          revokedAt: d.revokedAt === null ? null : new Date(d.revokedAt).toISOString(),
        })),
      });
    } catch {
      sendJson(res, 500, { code: 'fleet-control-failed', error: 'the remote devices request failed' });
    }
    return true;
  }
  if (path === '/api/verse/fleet/control/lanes') {
    try {
      const { readLaneTargets, setLaneTarget, parseLaneTargetAction, LaneTargetError } = await import('../fleet/runs-lane-targets.js');
      if (method === 'GET') {
        if (noQuery(req, res)) sendJson(res, 200, await readLaneTargets());
      } else if (method === 'POST') {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        const action = parseLaneTargetAction(body);
        if (!action) { sendInvalid(res, 'invalid lane target'); return true; }
        if (actionInFlight) {
          sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
          return true;
        }
        const run = setLaneTarget(action.lane, action.target);
        actionInFlight = run;
        try { sendJson(res, 200, await run); }
        catch (error) {
          if (error instanceof LaneTargetError) sendJson(res, error.status, { code: error.code, error: error.message });
          else throw error;
        } finally { actionInFlight = null; }
      } else sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
    }
    return true;
  }
  if (path === '/api/verse/fleet/control/switches') {
    try {
      const { readRunsSwitches, setRunsSwitch, parseSwitchAction } = await import('../fleet/runs-switches.js');
      if (method === 'GET') {
        if (noQuery(req, res)) sendJson(res, 200, await readRunsSwitches());
      } else if (method === 'POST') {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        const action = parseSwitchAction(body);
        if (!action) { sendInvalid(res, 'invalid switch'); return true; }
        if (actionInFlight) {
          sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
          return true;
        }
        const run = setRunsSwitch(action.id, action.on);
        actionInFlight = run;
        try { sendJson(res, 200, await run); }
        finally { actionInFlight = null; }
      } else sendJson(res, 405, { error: 'method not allowed' });
    } catch {
      sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
    }
    return true;
  }
  const isRoot = path === VERSE_FLEET_CONTROL_PATH;
  const isQueue = path === VERSE_FLEET_CONTROL_QUEUE_PATH;
  const isRunLog = path.startsWith(VERSE_FLEET_CONTROL_RUNS_PREFIX) && path.endsWith('/log');
  if (!isRoot && !isQueue && !isRunLog) return false;
  try {
    if (method === 'GET') {
      if (!noQuery(req, res)) return true;
      const d = await currentDeps();
      if (isRoot) {
        sendJson(res, 200, await readFleetControlState(d));
        return true;
      }
      if (isQueue) {
        sendJson(res, 200, await readFleetControlQueue(d));
        return true;
      }
      let runId: string;
      try {
        runId = decodeURIComponent(path.slice(VERSE_FLEET_CONTROL_RUNS_PREFIX.length, -'/log'.length));
      } catch {
        sendInvalid(res, 'invalid run id');
        return true;
      }
      if (!isRunId(runId)) {
        sendInvalid(res, 'invalid run id');
        return true;
      }
      sendJson(res, 200, await readFleetRunLog(runId, d));
      return true;
    }
    if (method === 'POST' && isRoot) {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      let action;
      try {
        action = parseFleetControlAction(body);
      } catch (error) {
        if (error instanceof FleetControlError) {
          sendJson(res, error.status, { code: error.code, error: error.message });
          return true;
        }
        throw error;
      }
      if (actionInFlight) {
        sendJson(res, 409, { code: 'busy', error: 'Another fleet control action is still running — try again in a moment.' });
        return true;
      }
      const run = currentDeps().then((d) => applyFleetControlAction(action, d));
      actionInFlight = run;
      try {
        sendJson(res, 200, await run);
      } catch (error) {
        if (error instanceof FleetControlError) sendJson(res, error.status, { code: error.code, error: error.message });
        else sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control action failed' });
      } finally {
        actionInFlight = null;
      }
      return true;
    }
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  } catch {
    sendJson(res, 500, { code: 'fleet-control-failed', error: 'the fleet control request failed' });
    return true;
  }
};
