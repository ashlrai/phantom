/** Desktop and agent read of the unified comms inbox (Needs-you lines, unanswered
 * teammate texts, pending email drafts, unclaimed bus work) as one ranked list.
 * Read-only: `readUnifiedInbox` never writes, sends, claims or resolves. Items
 * quote private text, so it answers only the local dispatch session. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { readUnifiedInbox, type UnifiedInbox, type UnifiedInboxOptions } from '../comms/unified-inbox.js';

export const VERSE_COMMS_INBOX_PATH = '/api/verse/comms/inbox';
const SCHEMA = 'comms.unified-inbox.v1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface CommsInboxApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Default: the unified inbox's own bus root. */
  busRoot?: string;
  /** Clock seam for tests. */
  now?: () => number;
  /** Reader seam for tests. */
  read?: (options: UnifiedInboxOptions) => Promise<UnifiedInbox>;
}

/** 1..200, or null for anything that is not a plain integer in range. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

export function createCommsInboxApi(deps: CommsInboxApiDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_COMMS_INBOX_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The comms inbox is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    let limit: number | null;
    try {
      limit = parseLimit(new URL(req.url ?? path, 'http://localhost').searchParams.get('limit'));
    } catch {
      limit = null;
    }
    if (limit === null) {
      sendJson(res, 400, { error: `limit must be an integer from 1 to ${MAX_LIMIT}.` });
      return true;
    }
    try {
      const inbox = await (deps.read ?? readUnifiedInbox)({
        runsDir: deps.runsDir ?? fixedOwnerRunsDir(),
        ...(deps.busRoot ? { busRoot: deps.busRoot } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      const items = inbox.items.slice(0, limit);
      sendJson(res, 200, {
        schema: SCHEMA,
        generatedAt: inbox.generatedAt,
        sources: inbox.sources,
        total: inbox.total,
        omitted: Math.max(0, inbox.total - items.length),
        items,
      });
    } catch {
      sendJson(res, 200, { schema: SCHEMA, unavailable: true, items: [] });
    }
    return true;
  };
}

export const handleCommsInboxApi: ApiModule = createCommsInboxApi();
