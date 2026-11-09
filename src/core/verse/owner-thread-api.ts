import type { IncomingMessage, ServerResponse } from 'node:http';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings, type OwnerThreadSettings } from '../comms/owner-channel.js';
import { readOwnerCommsStatus, readOwnerThread } from '../comms/owner-thread.js';
import { sendJson } from '../web/api.js';

export const OWNER_THREAD_PATH = '/api/verse/comms/owner-thread';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** Test seam only. Production paths are fixed; neither env nor the request chooses them. */
export interface OwnerThreadApiDeps { runsDir: string; settings: OwnerThreadSettings }

/**
 * Read-only owner thread (Telegram, Slack, email, iMessage, desktop) for the
 * local Leader pane. Bodies are private: this route is deliberately absent from
 * the phone/remote allow list. Read-session authentication precedes dispatch.
 */
export async function handleOwnerThreadApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, deps?: OwnerThreadApiDeps): Promise<boolean> {
  if (path !== OWNER_THREAD_PATH) return false;
  if (method !== 'GET') { sendJson(res, 405, { error: 'The owner thread is read only here.' }); return true; }
  let limit = DEFAULT_LIMIT;
  try {
    const raw = new URL(req.url ?? path, 'http://localhost').searchParams.get('limit');
    if (raw !== null) {
      limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
      if (limit < 1 || limit > MAX_LIMIT) { sendJson(res, 400, { error: `limit must be an integer from 1 to ${MAX_LIMIT}.` }); return true; }
    }
  } catch { sendJson(res, 400, { error: 'Invalid query string.' }); return true; }
  // No transports: a read never touches a channel.
  const options = deps ?? { runsDir: fixedOwnerRunsDir(), settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) };
  sendJson(res, 200, { ...readOwnerThread(options, limit), status: readOwnerCommsStatus(options) });
  return true;
}
