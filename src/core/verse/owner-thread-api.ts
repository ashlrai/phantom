/** Desktop read of the owner thread (iMessage, Telegram, Slack, email and desktop
 * lines in one ordered file) plus per-channel adapter state. Read-only: no
 * transports are passed, so this never sends, pulls or touches a channel. Owner
 * message bodies are private, so it answers only the local dispatch session.
 * Also exports the best-effort mirror of a desktop inbox post onto the thread. */
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings, type OwnerThreadSettings } from '../comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, type OwnerThreadOptions, type OwnerThreadResult } from '../comms/owner-thread.js';

export const VERSE_OWNER_THREAD_PATH = '/api/verse/comms/owner-thread';
/** Read-only "status now" brief for the Leader pane; same dispatch gate as the thread. */
export const VERSE_OWNER_STATUS_PATH = `${VERSE_OWNER_THREAD_PATH}/status`;
/** Read-only comms.toml confirmation for Settings. There is no write twin: the flag is Mason's alone. */
export const VERSE_OWNER_COMMS_LIMITS_PATH = `${VERSE_OWNER_THREAD_PATH}/comms-limits`;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface OwnerThreadApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Default: the fixed owner config dir. */
  configDir?: string;
  /** Settings seam for tests; default loads them from configDir. */
  settings?: OwnerThreadSettings;
  /** Bus root and leader mailbox seams for tests; default is the thread's own. */
  busRoot?: string;
  mailbox?: OwnerThreadOptions['mailbox'];
  /** Status brief seam for tests; default is the Leader's instant brief. */
  statusBrief?: () => Promise<string>;
  /** Clock seam for tests. */
  now?: () => number;
}

/** The fixed owner dirs, never `$HOME` or the request, unless a test injects them. */
function runtime(deps: OwnerThreadApiDeps): OwnerThreadOptions {
  return {
    runsDir: deps.runsDir ?? fixedOwnerRunsDir(),
    settings: deps.settings ?? loadOwnerThreadSettings(deps.configDir ?? fixedOwnerConfigDir()),
    ...(deps.busRoot ? { busRoot: deps.busRoot } : {}),
    ...(deps.mailbox ? { mailbox: deps.mailbox } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
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
    if (path !== VERSE_OWNER_THREAD_PATH && path !== VERSE_OWNER_STATUS_PATH && path !== VERSE_OWNER_COMMS_LIMITS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The owner thread is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (path === VERSE_OWNER_STATUS_PATH) {
      try {
        // Loaded on first ask: the brief composer is heavy and only this route needs it.
        const text = await (deps.statusBrief ? deps.statusBrief() : (await import('../comms/leader-line.js')).instantBrief(ctx.cfg));
        sendJson(res, 200, { schema: 'comms.owner-status.v1', text, at: new Date(deps.now?.() ?? Date.now()).toISOString() });
      } catch {
        sendJson(res, 200, { schema: 'comms.owner-status.v1', unavailable: true });
      }
      return true;
    }
    if (path === VERSE_OWNER_COMMS_LIMITS_PATH) {
      // Same parseCommsConfirmation read of the same fixed comms.toml the owner sends gate on.
      const configDir = deps.configDir ?? fixedOwnerConfigDir();
      try {
        const confirmedByMason = (deps.settings ?? loadOwnerThreadSettings(configDir)).confirmed;
        sendJson(res, 200, { schema: 'comms.limits.v1', confirmedByMason, path: join(configDir, 'comms.toml') });
      } catch {
        sendJson(res, 200, { schema: 'comms.limits.v1', unavailable: true });
      }
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
      const options = runtime(deps);
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

/**
 * Copy an accepted desktop inbox text onto the owner thread. Best-effort: it
 * never throws, and KILL, pause, an unconfirmed owner or a bad key come back
 * as a status the caller may ignore. The key derives from the inbox receipt's
 * stable dedupe key, so a repost is one thread message.
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
