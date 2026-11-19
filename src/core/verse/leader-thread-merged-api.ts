/** GET /api/verse/leader/thread/merged[?since=<hours>] → LeaderThreadRead: Mason's inbox, the outbox and the plan-log replies as one thread (read-only). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { readLeaderThread } from '../fleet/leader-thread-merge.js';
import { authorizeLeaderAttachmentRead } from './leader-attachment-read-api.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_LEADER_THREAD_MERGED_PATH = '/api/verse/leader/thread/merged';

export async function handleLeaderThreadMerged(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!authorizeLeaderAttachmentRead(ctx, req, res)) return true;
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('since');
  const since = raw === null ? undefined : Number(raw);
  if (since !== undefined && !(since > 0 && since <= 24 * 365)) { sendJson(res, 400, { error: 'since is a number of hours, above 0' }); return true; }
  sendJson(res, 200, await readLeaderThread(since === undefined ? {} : { sinceHours: since }));
  return true;
}
