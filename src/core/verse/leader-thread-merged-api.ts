/** GET /api/verse/leader/thread/merged[?since=<hours|time>&limit=<n>] → LeaderThreadRead: Mason's inbox, the outbox and the plan-log replies as one thread (read-only). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { parseThreadWindow, readLeaderThread } from '../fleet/leader-thread-merge.js';
import { authorizeLeaderAttachmentRead } from './leader-attachment-read-api.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_LEADER_THREAD_MERGED_PATH = '/api/verse/leader/thread/merged';

export async function handleLeaderThreadMerged(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!authorizeLeaderAttachmentRead(ctx, req, res)) return true;
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const opts = parseThreadWindow(params.get('since') ?? undefined, params.get('limit') ?? undefined);
  if (opts === null) { sendJson(res, 400, { error: 'since is hours above 0 or a date; limit is a whole number above 0' }); return true; }
  sendJson(res, 200, await readLeaderThread(opts));
  return true;
}
