import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readSlackRequestTrace, type SlackRequestTraceRead } from '../agents/slack-request-trace.js';

export const SLACK_TRACE_ROWS = 20;
export const SLACK_TRACE_TIMEOUT_MS = 5_000;

/** Read-only: the trace never sends, ledgers or appends to the bus. Rows are ids and timestamps only. */
export function createFleetSlackTraceApi(
  read: () => SlackRequestTraceRead | Promise<SlackRequestTraceRead> = () => readSlackRequestTrace(),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/slack-trace') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const trace = await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SLACK_TRACE_TIMEOUT_MS); }),
      ]);
      // Rows arrive oldest first; keep the newest 20, newest first. counts/sources describe the full set.
      const truncated = trace.rows.length > SLACK_TRACE_ROWS;
      sendJson(res, 200, { ...trace, rows: trace.rows.slice(-SLACK_TRACE_ROWS).reverse(), truncated });
    } catch { sendJson(res, 503, { error: 'slack trace unavailable' }); }
    finally { if (timer) clearTimeout(timer); }
    return true;
  };
}
export const handleFleetSlackTraceApi = createFleetSlackTraceApi();
