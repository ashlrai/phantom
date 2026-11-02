/**
 * Fleet control API — 3.15, the Fleet tab's control surface. Mounted by C0 in
 * verse-api.ts (WORKBENCH_ROUTE_FAMILIES id `fleet-control`).
 *
 *   GET  /api/verse/fleet/control               → FleetControlStateV1
 *   GET  /api/verse/fleet/control/queue         → FleetControlQueueV1
 *   GET  /api/verse/fleet/control/runs/<id>/log → FleetRunLogV1
 *   GET  /api/verse/fleet/control/stray-slots   → StraySlotsV1 (counted slots lost to strays)
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
import { readDropJobFates } from '../fleet/drop-job-fate.js';
export type { DropJobFatesV1 } from '../fleet/drop-job-fate.js';

import { isRunId } from '../fleet/run-cancel.js';
import {
  VERSE_FLEET_CONTROL_PATH,
  VERSE_FLEET_CONTROL_QUEUE_PATH,
  VERSE_FLEET_CONTROL_RUNS_PREFIX,
} from '../fleet/fleet-control-types.js';
import {
  VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH,
  type StrayReaders,
} from '../fleet/stray-slots.js';

type ControlDeps = FleetControlDeps & {
  remoteAdmin?: (input: unknown) => Promise<unknown>;
  remoteDevices?: () => Pick<RemoteDeviceStore, 'list'>;
  strayReaders?: StrayReaders;
};
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

/** Bound reads separately from the visible Mac confirmation wait. */
async function remoteCommand(input: unknown, timeout: number): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = deps?.remoteAdmin ?? (await import('../web/remote-admin.js')).sendRemoteAdminCommand;
    const result = await Promise.race([
      run(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Remote command timed out'), { code: 'ETIMEDOUT' })), timeout);
      }),
    ]);
    if (!result || typeof result !== 'object' || Array.isArray(result) || 'error' in result) throw new Error('Remote command failed');
    return result as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}

function remoteUnavailable(error: unknown): boolean {
  return ['ENOENT', 'ECONNREFUSED', 'ETIMEDOUT'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** One action at a time: a double-click must not interleave Start with Stop. */
let actionInFlight: Promise<unknown> | null = null;

export const handleFleetControlApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path === '/api/verse/fleet/control/remote-phone' || path === '/api/verse/fleet/control/remote-pending'
    || path === '/api/verse/fleet/control/remote-pairing') {
    const pairing = path.endsWith('/remote-pairing');
    if (method !== (pairing ? 'POST' : 'GET')) { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!noQuery(req, res)) return true;
    try {
      if (pairing) {
        const body = await readMutationBody(ctx, req, res);
        if (!body) return true;
        if ((body.action !== 'approve' && body.action !== 'deny') || typeof body.id !== 'string'
          || !/^[0-9a-f-]{36}$/.test(body.id)) { sendInvalid(res, 'invalid pairing action or id'); return true; }
        const result = await remoteCommand({ action: body.action, id: body.id }, 70_000);
        // Project the operator result; never forward arbitrary socket fields.
        sendJson(res, 200, { v: 1, result: body.action === 'deny' ? { denied: result.denied === true }
          : { approved: result.approved === true, ...(typeof result.deviceId === 'string' ? { deviceId: result.deviceId.slice(0, 200) } : {}) } });
      } else {
        const phone = path.endsWith('/remote-phone');
        let result: Record<string, unknown> = {};
        let gateway = 'running';
        try { result = await remoteCommand({ action: phone ? 'info' : 'pending' }, 3_000); }
        catch (error) { if (!remoteUnavailable(error)) throw error; gateway = 'not-running'; }
        const base = { v: 1, generatedAt: new Date().toISOString(), gateway };
        if (phone) {
          let devices = result.devices;
          if (gateway === 'not-running') {
            const { createRemoteDeviceStore } = await import('../web/remote-device-store.js');
            const all = (deps?.remoteDevices?.() ?? createRemoteDeviceStore()).list();
            devices = { active: all.filter(d => d.revokedAt === null).length, revoked: all.filter(d => d.revokedAt !== null).length };
          }
          const counts = devices as { active: number; revoked: number };
          const publicOrigin = typeof result.publicOrigin === 'string' ? result.publicOrigin : null;
          sendJson(res, 200, { ...base, phoneUrl: publicOrigin === null ? null : publicOrigin + '/verse/m', publicOrigin,
            pending: typeof result.pending === 'number' ? result.pending : 0,
            devices: { active: counts.active, revoked: counts.revoked } });
        } else {
          const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 200) : '';
          const approvals = Array.isArray(result.approvals) ? result.approvals : [];
          sendJson(res, 200, { ...base, approvals: approvals.map((a: Record<string, unknown>) => ({
            id: text(a.id), label: text(a.label), email: text(a.email), subject: text(a.subject), deviceType: text(a.deviceType),
          })) });
        }
      }
    } catch {
      sendJson(res, 502, { code: 'remote-pairing-failed', error: 'the remote operator request failed' });
    }
    return true;
  }
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
  if (path === '/api/verse/fleet/control/drop-fates') {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    for (const key of params.keys()) {
      if (key !== 'limit') { sendInvalid(res, `unknown query parameter: ${key}`); return true; }
    }
    const raw = params.get('limit');
    if (params.getAll('limit').length > 1 || (raw !== null && (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50))) {
      sendInvalid(res, 'limit must be an integer from 1 to 50'); return true;
    }
    sendJson(res, 200, await readDropJobFates({ limit: raw === null ? 20 : Number(raw) }));
    return true;
  }
  if (path === VERSE_FLEET_CONTROL_STRAY_SLOTS_PATH) {
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!noQuery(req, res)) return true;
    try {
      const { readStraySlots, defaultStrayReaders } = await import('../fleet/stray-slots.js');
      const report = await readStraySlots(deps?.strayReaders ?? defaultStrayReaders);
      sendJson(res, 200, { v: 1, generatedAt: new Date().toISOString(), source: 'ok', lanes: report.lanes });
    } catch {
      // Host evidence is best-effort: an unreadable ps/runs source answers a
      // degraded report, never a 500.
      sendJson(res, 200, { v: 1, generatedAt: new Date().toISOString(), source: 'unavailable', lanes: [] });
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
