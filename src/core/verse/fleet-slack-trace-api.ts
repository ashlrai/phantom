import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { isSlackChannelId, isSlackTs } from '../agents/slack-network.js';
import { readSlackEvidenceBundle } from '../agents/slack-evidence-bundle.js';
import { readSlackRequestTrace, type SlackRequestTraceRead } from '../agents/slack-request-trace.js';

type ScopedOptions = { channelId?: string; maxAgeSeconds?: number };
type ScopedReader = (thread: string, options: ScopedOptions) => ReturnType<typeof readSlackEvidenceBundle> | Promise<ReturnType<typeof readSlackEvidenceBundle>>;

export const SLACK_TRACE_ROWS = 20;
export const SLACK_TRACE_TIMEOUT_MS = 5_000;

/** Read-only: the trace never sends, ledgers or appends to the bus. Rows are ids and timestamps only. */
export function createFleetSlackTraceApi(
  read: () => SlackRequestTraceRead | Promise<SlackRequestTraceRead> = () => readSlackRequestTrace(),
  readScoped: ScopedReader = (thread, options) => readSlackEvidenceBundle(thread, options),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/slack-trace') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const keys = [...params.keys()];
    const thread = params.get('thread');
    const channel = params.get('channel');
    const age = params.get('maxAgeSeconds');
    const maxAgeSeconds = age === null ? undefined : Number(age);
    if (keys.some((key) => !['thread', 'channel', 'maxAgeSeconds'].includes(key) || params.getAll(key).length !== 1) ||
        (keys.length > 0 && (thread === null || !isSlackTs(thread))) ||
        (channel !== null && !isSlackChannelId(channel)) ||
        (age !== null && (!/^[0-9]+$/.test(age) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds! <= 0))) {
      sendJson(res, 400, { error: 'invalid query parameters' }); return true;
    }
    const options: ScopedOptions = {};
    if (channel !== null) options.channelId = channel;
    if (maxAgeSeconds !== undefined) options.maxAgeSeconds = maxAgeSeconds;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const trace = await Promise.race([
        Promise.resolve().then(() => thread === null ? read() : readScoped(thread, options)),
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
