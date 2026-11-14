/** POST /api/verse/comms/teammate-reply: Mason answers one unanswered teammate
 * text (Dot / "Ashlr.") from the desktop Waiting list. Body `{ rowid, text }`.
 * The recipient is always the stored row's senderId; a request can name neither
 * a handle nor a sender. The transport re-checks the team-only send policy and
 * stays the only authority. Only an accepted send marks the text answered; an
 * uncertain one marks nothing so Mason checks Messages before sending again.
 * The reply text is never logged and never echoed: responses carry status and
 * rowid only. Same dispatch + mutation gate as the agent-bus POST. */
import type { ApiModule } from './api-modules.js';
import { handleCommsTeammateReplyAgeApi } from './comms-teammate-reply-age-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { markTeammateTextsAnswered, readTeammateTexts, type TeammateText } from '../comms/imessage-teammate-inbox.js';
import { sendApprovedTeammateMessage } from '../comms/imessage-teammate-transport.js';
import type { AshlrConfig } from '../types.js';

export const VERSE_COMMS_TEAMMATE_REPLY_PATH = '/api/verse/comms/teammate-reply';
const MAX_TEXT = 4000;

export interface CommsTeammateReplyApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Reader seam: unanswered teammate texts. */
  read?: (runsDir: string) => TeammateText[];
  /** Transport seam; tests never touch Messages. */
  send?: (text: string, senderId: string, cfg: AshlrConfig) => Promise<'accepted' | 'uncertain' | 'refused'>;
  /** Marker seam; tests never touch the teammates file. */
  mark?: (rowids: number[], runsDir: string) => number;
  /** Default: the strict read-only loader the transport uses. */
  loadConfig?: () => AshlrConfig | Promise<AshlrConfig>;
}

function parseBody(raw: string): { rowid: number; text: string } | null {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('rowid') || !keys.includes('text')) return null;
  const { rowid, text } = body as { rowid: unknown; text: unknown };
  if (typeof rowid !== 'number' || !Number.isSafeInteger(rowid) || rowid <= 0) return null;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return null;
  return { rowid, text };
}

export function createCommsTeammateReplyApi(deps: CommsTeammateReplyApiDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_COMMS_TEAMMATE_REPLY_PATH) return false;
    if (method !== 'POST') { sendJson(res, 405, { error: 'Use POST to reply to a teammate.' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    let raw: string;
    try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
    const input = parseBody(raw);
    if (!input) { sendJson(res, 400, { v: 1, status: 'invalid' }); return true; }
    const runsDir = deps.runsDir ?? fixedOwnerRunsDir();
    try {
      const row = (deps.read ?? (dir => readTeammateTexts({ runsDir: dir }).texts))(runsDir).find(t => t.rowid === input.rowid);
      if (!row) { sendJson(res, 404, { v: 1, status: 'unknown' }); return true; }
      let cfg: AshlrConfig;
      try { cfg = await (deps.loadConfig ?? (async () => (await import('../config.js')).loadConfigReadOnlyStrict()))(); }
      catch { sendJson(res, 403, { v: 1, status: 'refused' }); return true; }
      const outcome = await (deps.send ?? sendApprovedTeammateMessage)(input.text, row.senderId, cfg);
      if (outcome === 'refused') sendJson(res, 403, { v: 1, status: 'refused' });
      else if (outcome === 'uncertain') sendJson(res, 202, { v: 1, status: 'uncertain' });
      else {
        (deps.mark ?? markTeammateTextsAnswered)([row.rowid], runsDir);
        sendJson(res, 200, { v: 1, status: 'sent', rowid: row.rowid });
      }
    } catch { sendJson(res, 503, { v: 1, status: 'unavailable' }); }
    return true;
  };
}

const teammateReplyApi = createCommsTeammateReplyApi();

/** The family owns GET /api/verse/comms/teammate-reply-age too (a read-only
 * times-and-flags projection, comms-teammate-reply-age-api.ts): it answers
 * first by exact path; everything else stays the reply POST. */
export const handleCommsTeammateReplyApi: ApiModule = async (ctx, req, res, path, method) =>
  (await handleCommsTeammateReplyAgeApi(ctx, req, res, path, method)) || teammateReplyApi(ctx, req, res, path, method);
