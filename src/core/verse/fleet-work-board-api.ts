/** Desktop surface for the Nov12 22:30 ET coordination work board: the same
 * bounded `listWorkBoard` read `ashlr fleet work-board --json` and the MCP
 * `fleet_work_board` tool serve — recent durable bus requests classified
 * RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED with named claim owners,
 * newest first. Read-only: takes no writer lock, writes nothing, makes no
 * network calls and never returns message bodies. The fleet root is always
 * the server-owned <ashlrHome>/fleet — the request picks no root, path or
 * cwd. An unreadable inbox reports the board's own 'unavailable' shape,
 * never an invented empty "available" board.
 *
 * POST /api/verse/fleet/work-board/result is the desktop "record result"
 * action: it posts exactly the evidence-shaped bus reply `ashlr fleet
 * work-result` posts (shared workResultBody + postBusReply, same default
 * store). A result receipt is evidence, not authority: it does not complete
 * or release a claim, and routing labels do not authenticate the responder.
 * The V1 dispatch + mutation-token gate in verse-api.ts runs before this
 * module sees any non-GET request; no second token check lives here. */
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiModule } from './api-modules.js';
import { readBody, sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import {
  listWorkBoard,
  WORK_BOARD_DEFAULT_LIMIT,
  WORK_BOARD_MAX_LIMIT,
  type WorkBoardResult,
} from '../comms/work-board.js';
import { workResultBody, type WorkResultBody } from '../comms/work-result-body.js';
import { postBusReply, replyResult, type ReplyResult } from '../fleet/bus-reply-post.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { VERSE_FLEET_ORDER_STATE_PATH, handleFleetOrderStateApi } from './fleet-order-state-api.js';

export const VERSE_FLEET_WORK_BOARD_PATH = '/api/verse/fleet/work-board';
export const VERSE_FLEET_WORK_RESULT_PATH = `${VERSE_FLEET_WORK_BOARD_PATH}/result`;
/** Body cap for POST /result: the largest legal reply is a few KiB of ids and text. */
export const WORK_RESULT_MAX_BODY_BYTES = 16 * 1024;

const MAX_THREAD_CHARS = 200;

export interface FleetWorkBoardApiDeps {
  /** Reader seam for tests. Default: listWorkBoard() at the server fleet root. */
  read?: (opts: { root: string; now: number; limit?: number; channelRef?: string }) => WorkBoardResult;
  /** Clock seam for tests; stamps asOf and feeds the classifier. */
  now?: () => Date;
  /** Poster seam for tests. Default: postBusReply() at the default fleet root, as the CLI. */
  postReply?: (requestId: string, replyId: string, body: WorkResultBody) => ReplyResult;
  /** Sub-path module for /work-board/orders. Default: handleFleetOrderStateApi. */
  orders?: ApiModule;
}

const MAX_ID_CHARS = 200;
const RESULT_KEYS = new Set(['pr', 'head', 'tests', 'artifact', 'blocked']);
const TOP_KEYS = new Set(['requestId', 'replyId', 'result']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS && !CONTROL.test(value);
}

/** ReplyResult outcome → HTTP status. posted/duplicate are both success (a
 * retry with the same reply id is idempotent); invalid-input → 400;
 * request-not-found (missing or expired request) → 404; transport-refused
 * whose store answer was 'conflict' (the reply id already carries a
 * different body) → 409; every other transport refusal (store missing,
 * contended, full, unreadable) → 503, since a retry may succeed. */
function statusFor(result: ReplyResult): number {
  switch (result.outcome) {
    case 'posted': case 'duplicate': return 200;
    case 'invalid-input': return 400;
    case 'request-not-found': return 404;
    default: return result.transport === 'conflict' ? 409 : 503;
  }
}

async function handleResultPost(req: IncomingMessage, res: ServerResponse,
  post: NonNullable<FleetWorkBoardApiDeps['postReply']>): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, WORK_RESULT_MAX_BODY_BYTES);
  } catch {
    sendJson(res, 413, { error: 'request body too large' });
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { parsed = undefined; }
  const invalid = (error: string): void => sendJson(res, 400, { outcome: 'invalid-input', error });
  if (!isRecord(parsed) || Object.keys(parsed).some(k => !TOP_KEYS.has(k))) {
    return invalid('body must be {requestId, replyId, result}.');
  }
  const { requestId, replyId, result } = parsed;
  if (!validId(requestId) || !validId(replyId)) {
    return invalid(`requestId and replyId must be non-empty strings of at most ${MAX_ID_CHARS} chars without control characters.`);
  }
  const body = isRecord(result) && Object.keys(result).every(k => RESULT_KEYS.has(k)) ? workResultBody(result) : null;
  if (!body) return invalid('result must be exactly one of {pr, head}, {tests}, {artifact} or {blocked}.');
  let reply: ReplyResult;
  try {
    reply = post(requestId, replyId, body);
  } catch {
    reply = replyResult('transport-refused');
  }
  sendJson(res, statusFor(reply), sanitizePublicJson(reply));
}

/** Absent → the board default; a plain integer → clamped to 1..MAX; anything else → null (400). */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return WORK_BOARD_DEFAULT_LIMIT;
  if (!/^-?\d+$/.test(raw)) return null;
  return Math.min(Math.max(Number(raw), 1), WORK_BOARD_MAX_LIMIT);
}

export function createFleetWorkBoardApi(deps: FleetWorkBoardApiDeps = {}): ApiModule {
  const read = deps.read ?? ((opts) => listWorkBoard(opts));
  const now = deps.now ?? (() => new Date());
  const post = deps.postReply ?? ((requestId, replyId, body) => postBusReply(requestId, replyId, body));
  const orders = deps.orders ?? handleFleetOrderStateApi;
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_FLEET_ORDER_STATE_PATH) return orders(ctx, req, res, path, method);
    if (path === VERSE_FLEET_WORK_RESULT_PATH) {
      if (method !== 'POST') sendJson(res, 405, { error: 'method not allowed' });
      else await handleResultPost(req, res, post);
      return true;
    }
    if (path !== VERSE_FLEET_WORK_BOARD_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    let params: URLSearchParams;
    try {
      params = new URL(req.url ?? path, 'http://localhost').searchParams;
    } catch {
      params = new URLSearchParams();
    }
    const limit = parseLimit(params.get('limit'));
    if (limit === null) {
      sendJson(res, 400, { error: 'limit must be an integer.' });
      return true;
    }
    const thread = params.get('thread');
    if (thread !== null && thread.length > MAX_THREAD_CHARS) {
      sendJson(res, 400, { error: `thread must be a channel_ref of at most ${MAX_THREAD_CHARS} chars.` });
      return true;
    }
    const ms = now().getTime();
    const at = Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
    const asOf = new Date(at).toISOString();
    let board: WorkBoardResult;
    try {
      board = read({
        root: join(ashlrHome(), 'fleet'),
        now: at,
        limit,
        ...(thread !== null ? { channelRef: thread } : {}),
      });
    } catch {
      board = { items: [], inbox: 'unavailable', truncated: false, claims: 'unavailable' };
    }
    sendJson(res, 200, { ...board, asOf });
    return true;
  };
}

export const handleFleetWorkBoardApi: ApiModule = createFleetWorkBoardApi();
