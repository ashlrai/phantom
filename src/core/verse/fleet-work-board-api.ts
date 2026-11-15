/** Desktop surface for the Nov12 22:30 ET coordination work board: the same
 * bounded `listWorkBoard` read `ashlr fleet work-board --json` and the MCP
 * `fleet_work_board` tool serve — recent durable bus requests classified
 * RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED with named claim owners,
 * newest first. Read-only: takes no writer lock, writes nothing, makes no
 * network calls and never returns message bodies. The fleet root is always
 * the server-owned <ashlrHome>/fleet — the request picks no root, path or
 * cwd. An unreadable inbox reports the board's own 'unavailable' shape,
 * never an invented empty "available" board. */
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import {
  listWorkBoard,
  WORK_BOARD_DEFAULT_LIMIT,
  WORK_BOARD_MAX_LIMIT,
  type WorkBoardResult,
} from '../comms/work-board.js';

export const VERSE_FLEET_WORK_BOARD_PATH = '/api/verse/fleet/work-board';

const MAX_THREAD_CHARS = 200;

export interface FleetWorkBoardApiDeps {
  /** Reader seam for tests. Default: listWorkBoard() at the server fleet root. */
  read?: (opts: { root: string; now: number; limit?: number; channelRef?: string }) => WorkBoardResult;
  /** Clock seam for tests; stamps asOf and feeds the classifier. */
  now?: () => Date;
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
  return async (_ctx, req, res, path, method) => {
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
