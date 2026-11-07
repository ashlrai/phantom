/**
 * Read-only forum projection for the desktop and the phone.
 * GET /api/verse/forum[?channel=&thread=&limit=]
 * Agents post through `phm forum` or the `phantom_forum` MCP tool.
 * A current read session is required. The storage root is not a parameter.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForumDeps } from '../fleet/forum/service.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_FORUM_PATH = '/api/verse/forum';

export function createForumApi(deps: Partial<Pick<ForumDeps, 'root' | 'now' | 'env'>> = {}): ApiModule {
  return async (ctx: VerseApiContext, _req: IncomingMessage, res: ServerResponse, path: string, method: string) => {
    if (path !== VERSE_FORUM_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Forum posts use phm forum or the phantom_forum tool.' });
      return true;
    }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' });
      return true;
    }
    let params: URLSearchParams;
    try { params = new URL(_req.url ?? path, 'http://localhost').searchParams; } catch {
      sendJson(res, 400, { error: 'Invalid query.' });
      return true;
    }
    if ([...params.keys()].some((key) => !['channel', 'thread', 'limit'].includes(key) || params.getAll(key).length !== 1)) {
      sendJson(res, 400, { error: 'Invalid query.' });
      return true;
    }
    const limit = params.get('limit');
    const { forumRoot, readForum } = await import('../fleet/forum/service.js');
    const result = await readForum({
      channelId: params.get('channel') ?? undefined,
      threadId: params.get('thread') ?? undefined,
      limit: limit === null ? undefined : Number(limit),
    }, { root: deps.root ?? forumRoot(), now: deps.now, env: deps.env });
    if (!result.ok) {
      sendJson(res, result.reason === 'unavailable' ? 503 : 400, { v: 1, ok: false, reason: result.reason });
      return true;
    }
    sendJson(res, 200, result.view);
    return true;
  };
}

export const handleForumApi = createForumApi();
