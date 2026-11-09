/**
 * core/verse/owner-thread-api.ts — `GET /api/verse/comms/owner-thread?limit=N`
 * (mounted by verse-api.ts through the api-modules.ts contract), plus the
 * best-effort mirror of a desktop inbox post into the owner thread.
 *
 * Read-only: no mutation token. Settings absent or the owner unconfirmed
 * answers 200 with the `unavailable: true` shape, never an error.
 */
import { loadOwnerThreadSettings, fixedOwnerConfigDir, fixedOwnerRunsDir, type OwnerThreadSettings } from '../comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, type OwnerThreadOptions, type OwnerThreadResult } from '../comms/owner-thread.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const OWNER_THREAD_API_PATH = '/api/verse/comms/owner-thread';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface OwnerThreadApiDeps {
  runsDir?: string;
  configDir?: string;
  settings?: OwnerThreadSettings;
  busRoot?: string;
  mailbox?: OwnerThreadOptions['mailbox'];
  now?: () => number;
}

/** The same runtime the MCP tools build: the fixed owner dirs, never `$HOME`. */
function runtime(deps: OwnerThreadApiDeps): OwnerThreadOptions {
  return {
    runsDir: deps.runsDir ?? fixedOwnerRunsDir(),
    settings: deps.settings ?? loadOwnerThreadSettings(deps.configDir ?? fixedOwnerConfigDir()),
    ...(deps.busRoot ? { busRoot: deps.busRoot } : {}),
    ...(deps.mailbox ? { mailbox: deps.mailbox } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
}

export function createOwnerThreadApi(deps: OwnerThreadApiDeps = {}): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== OWNER_THREAD_API_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: `method not allowed: ${method} ${path}` }); return true; }
    const raw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
    const parsed = raw === null ? DEFAULT_LIMIT : Number(raw);
    const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;
    try {
      const options = runtime(deps);
      const status = readOwnerCommsStatus(options);
      const ready = Boolean(options.settings.owners.desktop) && options.settings.confirmed;
      const thread = ready ? readOwnerThread(options, limit) : { ...readOwnerThread(options, 1), messages: [], unavailable: true };
      sendJson(res, 200, { ...thread, status });
    } catch {
      sendJson(res, 200, { schema: 'comms.owner-thread.v1', messages: [], unavailable: true });
    }
    return true;
  };
}

export const handleOwnerThreadApi: ApiModule = createOwnerThreadApi();

/**
 * Copy an accepted desktop inbox text onto the owner thread. Best-effort: it
 * never throws, and KILL, pause, an unconfirmed owner or a bad key come back
 * as a status the caller may ignore. The key is derived from the inbox
 * receipt's stable dedupe key, so a repost is one thread message.
 */
export async function mirrorInboxToOwnerThread(text: string, dedupeKey: string, deps: OwnerThreadApiDeps = {}): Promise<{ status: OwnerThreadResult['status'] }> {
  try {
    const options = runtime(deps);
    const senderId = options.settings.owners.desktop;
    if (!senderId) return { status: 'unavailable' };
    const result = await acceptOwnerInbound({
      channel: 'desktop', senderId, text, idempotencyKey: `inbox:${dedupeKey.slice(0, 40)}`, at: (deps.now ?? Date.now)(),
    }, options);
    return { status: result.status };
  } catch { return { status: 'unavailable' }; }
}
