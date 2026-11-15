/**
 * Read-only one-call bridge verdict for the desktop: the HTTP face of the MCP tool `fleet_bridge_check`.
 *   GET /api/verse/fleet/runtime-identity/bridge-check -> { v: 1, authority: 'none', check }
 * Takes no query input and never writes. A reader that throws, rejects or stalls past the timeout
 * degrades to a fixed BLOCKED body; the thrown text is never sent.
 */
import { readFleetBridgeCheck } from '../../mcp/fleet-bridge-check.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_BRIDGE_CHECK_PATH = '/api/verse/fleet/runtime-identity/bridge-check';
export const BRIDGE_CHECK_TIMEOUT_MS = 8_000;

export interface FleetBridgeCheckApiDeps {
  /** Verdict reader; injected in tests. Default: readFleetBridgeCheck(). */
  read?: () => Promise<unknown> | unknown;
  /** Clock seam for the fallback asOf. */
  now?: () => Date;
}

export function createFleetBridgeCheckApi(deps: FleetBridgeCheckApiDeps = {}): ApiModule {
  const read = deps.read ?? (() => readFleetBridgeCheck());
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_BRIDGE_CHECK_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const failed = {
      verdict: 'BLOCKED', asOf: now().toISOString(),
      missing: ['bridge-check'], reason: 'bridge-check-reader-failed',
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let check: unknown;
    try {
      const timeout = new Promise<unknown>(resolve => {
        timer = setTimeout(() => resolve(failed), BRIDGE_CHECK_TIMEOUT_MS);
      });
      check = await Promise.race([Promise.resolve().then(read), timeout]);
    } catch {
      check = failed;
    } finally {
      if (timer) clearTimeout(timer);
    }
    sendJson(res, 200, { v: 1, authority: 'none', check });
    return true;
  };
}

export const handleFleetBridgeCheckApi: ApiModule = createFleetBridgeCheckApi();
