import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { authorizeLeaderAttachmentRead } from './leader-attachment-read-api.js';
import { listLeaderAttachments } from './leader-attachment-list.js';
import type { VerseApiContext } from './verse-api.js';

export async function handleLeaderAttachmentList(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, method: string): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  if (!authorizeLeaderAttachmentRead(ctx, req, res)) return true;
  const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
  sendJson(res, 200, await listLeaderAttachments({ limit: raw === null ? undefined : Number(raw) }));
  return true;
}
