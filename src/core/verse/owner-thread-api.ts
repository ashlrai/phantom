/** Desktop read of the owner thread (iMessage, Telegram, Slack, email and desktop
 * lines in one ordered file) plus per-channel adapter state. Read-only: no
 * transports are passed, so this never sends, pulls or touches a channel. Owner
 * message bodies are private, so it answers only the local dispatch session. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../comms/owner-channel.js';
import { readOwnerCommsStatus, readOwnerThread, type OwnerThreadOptions } from '../comms/owner-thread.js';

export const VERSE_OWNER_THREAD_PATH = '/api/verse/comms/owner-thread';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface OwnerThreadApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Default: the fixed owner config dir. */
  configDir?: string;
  /** Clock seam for tests. */
  now?: () => number;
}

const UNAVAILABLE = { schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [], unavailable: true } as const;

/** 1..200, or null for anything that is not a plain integer in range. */
function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

export function createOwnerThreadApi(deps: OwnerThreadApiDeps = {}): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_OWNER_THREAD_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The owner thread is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    let limit: number | null;
    try {
      limit = parseLimit(new URL(req.url ?? path, 'http://localhost').searchParams.get('limit'));
    } catch {
      limit = null;
    }
    if (limit === null) {
      sendJson(res, 400, { error: `limit must be an integer from 1 to ${MAX_LIMIT}.` });
      return true;
    }
    try {
      const options: OwnerThreadOptions = {
        runsDir: deps.runsDir ?? fixedOwnerRunsDir(),
        settings: loadOwnerThreadSettings(deps.configDir ?? fixedOwnerConfigDir()),
        ...(deps.now ? { now: deps.now } : {}),
      };
      const thread = readOwnerThread(options, limit);
      const { adapters, kill, paused } = readOwnerCommsStatus(options);
      sendJson(res, 200, {
        ...thread,
        status: {
          kill,
          paused,
          adapters: adapters.map(({ id, enabled, configured, halted, reason, nextStep }) => ({ id, enabled, configured, halted, reason, nextStep })),
        },
      });
    } catch {
      sendJson(res, 200, UNAVAILABLE);
    }
    return true;
  };
}

export const handleOwnerThreadApi: ApiModule = createOwnerThreadApi();
