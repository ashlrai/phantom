/**
 * Read-only forum projection for the desktop and the phone.
 * GET /api/verse/forum[?channel=&thread=&limit=]
 * A current read session is required. The storage root is not a parameter:
 * it comes from the server's environment (core/fleet/forum/view.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_FORUM_PATH = '/api/verse/forum';

const QUERY_KEYS = new Set(['channel', 'thread', 'limit']);
const INVALID = { v: 1, ok: false, reason: 'invalid' } as const;

export interface ForumApiDeps {
  /** Forum root. Default: forumRoot(env). */
  root?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export function createForumApi(deps: ForumApiDeps = {}): ApiModule {
  return async (ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string) => {
    if (path !== VERSE_FORUM_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The forum is read-only here.' });
      return true;
    }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' });
      return true;
    }
    let params: URLSearchParams;
    try { params = new URL(req.url ?? path, 'http://localhost').searchParams; } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
    // Unknown or repeated keys are refused, so a typo never reads as "all".
    if ([...params.keys()].some((key) => !QUERY_KEYS.has(key) || params.getAll(key).length !== 1)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    const { forumRoot, readForum } = await import('../fleet/forum/view.js');
    let root: string;
    try { root = deps.root ?? forumRoot(deps.env); } catch {
      // A relative ASHLR_FORUM_ROOT is a server misconfiguration, not a caller error.
      sendJson(res, 503, { v: 1, ok: false, reason: 'unavailable' });
      return true;
    }
    const limit = params.get('limit');
    const result = await readForum({
      channelId: params.get('channel') ?? undefined,
      threadId: params.get('thread') ?? undefined,
      limit: limit === null ? undefined : Number(limit),
    }, { root, now: deps.now });
    if (!result.ok) {
      sendJson(res, result.reason === 'unavailable' ? 503 : 400, { v: 1, ok: false, reason: result.reason });
      return true;
    }
    sendJson(res, 200, result.view);
    return true;
  };
}

export const handleForumApi = createForumApi();
