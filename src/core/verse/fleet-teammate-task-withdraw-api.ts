/**
 * Teammate task withdraw — POST /api/verse/fleet/control/teammate-tasks/withdraw
 * body `{ jobId }`. This withdraws a LOCAL reservation only and never asserts a
 * remote stop: core's cancelTeammateTask refuses unless it can prove nothing was
 * sent, and this edge relays only a projection of its answer (never the task,
 * receipt, token or claim key). Same gate as fleet-holds-api.ts: dispatch on,
 * mutation token, JSON object body. Errors never echo their message.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { cancelTeammateTask } from '../comms/imessage-teammate-tasks.js';
import type { ApiModule } from './api-modules.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';

export const VERSE_FLEET_TEAMMATE_TASK_WITHDRAW_PATH = '/api/verse/fleet/control/teammate-tasks/withdraw';

type Cancel = (jobId: string, opts: { apply: true }) => unknown;

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const UNAVAILABLE = { code: 'unavailable', error: 'teammate task withdraw unavailable' };

function publicReceipt(result: unknown, jobId: string) {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const { state, reason } = result as Record<string, unknown>;
  switch (state) {
    case 'cancelled':
    case 'planned':
      return { v: 1, jobId, state };
    case 'refused':
      return { v: 1, jobId, state, reason: reason === 'Cancellation cannot prove a remote stop'
        ? 'Cancellation cannot prove a remote stop' : reason === 'Teammate queue claim changed'
          ? 'Teammate queue claim changed' : 'Teammate task withdrawal refused' };
    case 'unavailable':
      return { v: 1, jobId, state, reason: reason === 'Teammate task not found'
        ? 'Teammate task not found' : 'Teammate task withdraw unavailable' };
    default:
      return null;
  }
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

async function readMutationBody(ctx: Parameters<ApiModule>[0], req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
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

/** One withdraw at a time: a double-click must not interleave two ledger rewrites. */
let inFlight: Promise<unknown> | null = null;

export function createFleetTeammateTaskWithdrawApi(cancel: Cancel = cancelTeammateTask): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_TEAMMATE_TASK_WITHDRAW_PATH) return false;
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const body = await readMutationBody(ctx, req, res);
    if (!body) return true;
    const keys = Object.keys(body);
    const jobId = body.jobId;
    if (keys.length !== 1 || keys[0] !== 'jobId' || typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
      sendInvalid(res, 'body must be exactly { jobId }');
      return true;
    }
    if (inFlight) {
      sendJson(res, 409, { code: 'busy' });
      return true;
    }
    const run = Promise.resolve().then(() => cancel(jobId, { apply: true }));
    inFlight = run;
    try {
      const out = publicReceipt(await run, jobId);
      sendJson(res, !out || out.state === 'unavailable' ? 503 : 200, out ?? UNAVAILABLE);
    } catch (error) {
      if (error instanceof Error && error.message === 'Teammate tasks busy') sendJson(res, 409, { code: 'busy' });
      else sendJson(res, 503, UNAVAILABLE);
    } finally {
      inFlight = null;
    }
    return true;
  };
}

export const handleFleetTeammateTaskWithdrawApi: ApiModule = createFleetTeammateTaskWithdrawApi();
