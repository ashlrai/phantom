/**
 * GET /api/verse/comms/teammate-reply-age → comms.teammate-reply-age.v1
 *
 * Read-only projection of the durable teammate inbox record,
 * <runs>/imessage/teammates.jsonl (comms/imessage-teammate-inbox.ts), the same
 * file `ashlr fleet teammate-texts` and the unified inbox read: one
 * `{v,at,rowid,senderId,text}` line per allowlisted non-Mason iMessage (Dot /
 * "Ashlr."), one `{v,answered,at}` marker per resolved text (the teammate
 * responder after a confirmed send or a suppress, or Mason's desktop reply).
 *
 * The answer to "was Dot's last text answered" is computed per rowid, not by
 * clocks: `lastOutboundAt` is the marker time of the NEWEST inbound text — the
 * outbound reply that answers it — so it is null while that text is
 * unanswered. `answered` is null when there is no inbound record at all;
 * `source` mirrors readRows (missing file is 'missing', torn lines are
 * 'degraded'). The response carries times and flags only — never message
 * text, sender ids, handles or phone numbers.
 */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { readRows, type TeammateRow, type TeammateSourceState } from '../comms/imessage-teammate-inbox.js';

export const VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH = '/api/verse/comms/teammate-reply-age';
const SCHEMA = 'comms.teammate-reply-age.v1';

export interface CommsTeammateReplyAgeApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Reader seam: the teammates.jsonl rows. Defaults to the inbox's own readRows. */
  read?: (runsDir: string) => { rows: TeammateRow[]; state: TeammateSourceState };
}

export interface TeammateReplyAge {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  answered: boolean | null;
}

const validRowid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const validAt = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/**
 * Newest inbound text row (same at-asc, rowid-asc order readTeammateTexts uses)
 * and the answer-marker time for that rowid only. A marker can never precede
 * the text it answers, so lastOutboundAt >= lastInboundAt exactly when the
 * newest text is answered.
 */
export function teammateReplyAge(rows: readonly TeammateRow[]): TeammateReplyAge {
  let newest: { at: string; atMs: number; rowid: number } | null = null;
  const answeredAt = new Map<number, number>();
  for (const row of rows) {
    if (!validAt(row.at)) continue;
    const atMs = Date.parse(row.at);
    if (validRowid(row.answered)) {
      if (atMs > (answeredAt.get(row.answered) ?? 0)) answeredAt.set(row.answered, atMs);
      continue;
    }
    if (validRowid(row.rowid) && typeof row.senderId === 'string' && typeof row.text === 'string'
      && (newest === null || atMs > newest.atMs || (atMs === newest.atMs && row.rowid > newest.rowid))) {
      newest = { at: row.at, atMs, rowid: row.rowid };
    }
  }
  if (newest === null) return { lastInboundAt: null, lastOutboundAt: null, answered: null };
  const marker = answeredAt.get(newest.rowid);
  return {
    lastInboundAt: newest.at,
    lastOutboundAt: marker === undefined ? null : new Date(marker).toISOString(),
    answered: marker !== undefined,
  };
}

export function createCommsTeammateReplyAgeApi(deps: CommsTeammateReplyAgeApiDeps = {}): ApiModule {
  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_COMMS_TEAMMATE_REPLY_AGE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The teammate reply age is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const runsDir = deps.runsDir ?? fixedOwnerRunsDir();
    try {
      const { rows, state } = (deps.read ?? readRows)(runsDir);
      sendJson(res, 200, { schema: SCHEMA, source: state, ...teammateReplyAge(rows) });
    } catch {
      // Unknown stays unknown: a read failure is never a fabricated time.
      sendJson(res, 200, { schema: SCHEMA, source: 'unavailable', lastInboundAt: null, lastOutboundAt: null, answered: null });
    }
    return true;
  };
}

export const handleCommsTeammateReplyAgeApi: ApiModule = createCommsTeammateReplyAgeApi();
