/**
 * GET/POST /api/verse/comms/confirm — the desktop console's one-click Comms
 * confirmation (RQ-PHX-COMMSCONFIRMDESK09).
 *
 * GET (behind the read-session boundary in server.ts) reports the limits, their
 * digest and the confirmation state; it never writes.
 *
 * POST is the ONLY writer of `confirmedByMason`. It reuses the owner gate every
 * Verse mutation uses (ctx.allowDispatch + passesMutationGate: the per-server
 * x-ashlr-token that lives only in the desktop app's memory or the operator's
 * terminal) and adds three human-only checks on top:
 *   - any Authorization header is refused, so a Verse turn's MCP bearer never counts;
 *   - Origin must be this server's own origin (a browser page on it), which the
 *     phone gateway's server-side forward and plain HTTP clients do not send;
 *   - Sec-Fetch-Site, when sent, must be same-origin.
 * The phone gateway's path allowlist (remote-gateway-policy.ts) does not include it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { confirmCommsLimits, readCommsLimits } from '../comms/comms-confirm.js';
import { realHome } from '../real-home.js';
import { passesMutationGate, readBody, sendJson } from './api.js';
import { headerValue } from './read-session.js';

export const COMMS_CONFIRM_PATH = '/api/verse/comms/confirm';

export interface CommsConfirmRouteContext {
  token: string;
  allowDispatch: boolean;
  /** Test seam; defaults to the account home's `.ashlr`, the directory the transports read. */
  configDir?: string;
  now?: () => Date;
}

const REFUSED: Record<string, [number, string]> = {
  missing: [404, 'comms.toml does not exist. Create it first; this button never creates it.'],
  malformed: [422, 'comms.toml could not be read safely. Fix it by hand, then reload.'],
  'digest-mismatch': [409, 'The limits changed since you loaded them. Reload and review them again.'],
  changed: [409, 'comms.toml changed while confirming. Reload and review it again.'],
  'io-error': [500, 'Could not write comms.toml.'],
};

function configDirOf(ctx: CommsConfirmRouteContext): string | null {
  if (ctx.configDir) return ctx.configDir;
  const home = realHome();
  return home ? join(home, '.ashlr') : null;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = headerValue(req, 'origin');
  const host = headerValue(req, 'host');
  if (!origin || !host || origin !== `http://${host}`) return false;
  const site = headerValue(req, 'sec-fetch-site');
  return site === '' || site === 'same-origin';
}

export async function handleCommsConfirmRoute(
  ctx: CommsConfirmRouteContext, req: IncomingMessage, res: ServerResponse, method: string,
): Promise<boolean> {
  const dir = configDirOf(ctx);
  if (method === 'GET') {
    sendJson(res, 200, dir ? readCommsLimits(dir) : { state: 'unknown', limits: null, digest: null, confirmedAt: null });
    return true;
  }
  if (method !== 'POST' || !ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (req.headers.authorization !== undefined) {
    sendJson(res, 403, { error: 'Only Mason can confirm Comms limits, from the desktop app.' });
    return true;
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: 'Confirm Comms limits from the desktop app.' });
    return true;
  }
  if (!passesMutationGate(req, res, ctx.token)) return true;
  let digest: unknown;
  try { digest = (JSON.parse(await readBody(req, 1024)) as { limitsDigest?: unknown }).limitsDigest; }
  catch { digest = undefined; }
  if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    sendJson(res, 400, { error: 'Provide the limitsDigest you reviewed.' });
    return true;
  }
  if (!dir) {
    sendJson(res, 503, { error: 'The account home is unavailable.' });
    return true;
  }
  const result = confirmCommsLimits(dir, { limitsDigest: digest, confirmedAt: (ctx.now?.() ?? new Date()).toISOString() });
  if (!result.ok) {
    const [status, error] = REFUSED[result.reason]!;
    sendJson(res, status, { error, code: result.reason });
    return true;
  }
  sendJson(res, 200, readCommsLimits(dir));
  return true;
}
