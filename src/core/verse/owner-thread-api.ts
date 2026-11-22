/** Desktop read of the owner thread (iMessage, Telegram, Slack, email and desktop
 * lines in one ordered file) plus per-channel adapter state. Read-only: no
 * transports are passed, so this never sends, pulls or touches a channel. Owner
 * message bodies are private, so it answers only the local dispatch session.
 * Also exports the best-effort mirror of a desktop inbox post onto the thread. */
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { MASON_THREAD_SCHEMA, readMasonThread } from '../comms/mason-thread.js';
import { parseSince } from '../fleet/agent-messages.js';
import type { LeaderBriefV1 } from '../fleet/leader-job-brief.js';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings, type OwnerThreadSettings } from '../comms/owner-channel.js';
import { OWNER_CHANNELS, isOwnerChannel, type OwnerChannel } from '../comms/leader-mailbox.js';
import { OWNER_THREAD_CONTAINS_MAX, acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, type OwnerThreadOptions, type OwnerThreadResult } from '../comms/owner-thread.js';

export const VERSE_OWNER_THREAD_PATH = '/api/verse/comms/owner-thread';
/** Read-only "status now" brief for the Leader pane; same dispatch gate as the thread. */
export const VERSE_OWNER_STATUS_PATH = `${VERSE_OWNER_THREAD_PATH}/status`;
/** Read-only comms.toml confirmation for Settings. There is no write twin: the flag is Mason's alone. */
export const VERSE_OWNER_COMMS_LIMITS_PATH = `${VERSE_OWNER_THREAD_PATH}/comms-limits`;
/** Read-only one-timeline view for the Mason panel: same data as `phm mason thread --json`. */
export const VERSE_MASON_THREAD_PATH = '/api/verse/comms/mason-thread';
/** Read-only twin of `phm leader brief --json` for the Leader card: the typed brief, nothing reshaped. */
export const VERSE_LEADER_BRIEF_PATH = '/api/verse/comms/leader-brief';
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
  /** Leader job brief seam for tests; default is the same read `phm leader brief` makes. */
  jobBrief?: () => Promise<LeaderBriefV1>;
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
    if (path !== VERSE_OWNER_THREAD_PATH && path !== VERSE_OWNER_STATUS_PATH && path !== VERSE_OWNER_COMMS_LIMITS_PATH && path !== VERSE_MASON_THREAD_PATH && path !== VERSE_LEADER_BRIEF_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The owner thread is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (path === VERSE_MASON_THREAD_PATH) {
      const now = deps.now?.() ?? Date.now();
      let sinceMs: number | null = null;
      try { sinceMs = parseSince(new URL(req.url ?? path, 'http://localhost').searchParams.get('since') ?? '1d', now); } catch { /* 400 below */ }
      if (sinceMs === null) {
        sendJson(res, 400, { error: 'since takes 15m, 2h, 1d, epoch ms or an ISO time.' });
        return true;
      }
      try {
        const options = runtime(deps);
        sendJson(res, 200, await readMasonThread({ runsDir: options.runsDir, busRoot: deps.busRoot ?? join(ashlrHome(), 'fleet'), owner: options, sinceMs, now }));
      } catch {
        sendJson(res, 200, { schema: MASON_THREAD_SCHEMA, unavailable: true });
      }
      return true;
    }
    if (path === VERSE_LEADER_BRIEF_PATH) {
      try {
        // Loaded on first ask: it reads the queue, ledger and pools, which only this route needs.
        const brief = await (deps.jobBrief ? deps.jobBrief() : (await import('../fleet/leader-job-brief.js')).readJobBrief({ ...(deps.now ? { now: deps.now() } : {}) }));
        sendJson(res, 200, brief);
      } catch {
        sendJson(res, 200, { schema: 'leader.brief.v1', unavailable: true });
      }
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
    let channel: OwnerChannel | undefined;
    let since: number | undefined;
    let contains: string | undefined;
    try {
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      limit = parseLimit(params.get('limit'));
      const channelRaw = params.get('channel');
      if (channelRaw !== null) {
        if (!isOwnerChannel(channelRaw)) {
          sendJson(res, 400, { error: `channel must be one of: ${OWNER_CHANNELS.join(', ')}.` });
          return true;
        }
        channel = channelRaw;
      }
      const sinceRaw = params.get('since');
      if (sinceRaw !== null) {
        const parsed = parseSince(sinceRaw);
        if (parsed === null) {
          sendJson(res, 400, { error: 'since takes 15m, 2h, 1d, epoch ms or an ISO time.' });
          return true;
        }
        since = parsed;
      }
      const containsRaw = params.get('contains');
      if (containsRaw !== null) {
        if (containsRaw.trim() === '' || containsRaw.length > OWNER_THREAD_CONTAINS_MAX) {
          sendJson(res, 400, { error: `contains takes a non-empty search text of at most ${OWNER_THREAD_CONTAINS_MAX} characters.` });
          return true;
        }
        contains = containsRaw;
      }
    } catch {
      limit = null;
    }
    if (limit === null) {
      sendJson(res, 400, { error: `limit must be an integer from 1 to ${MAX_LIMIT}.` });
      return true;
    }
    try {
      const options = runtime(deps);
      const filter = channel !== undefined || since !== undefined || contains !== undefined
        ? { ...(channel !== undefined ? { channel } : {}), ...(since !== undefined ? { since } : {}), ...(contains !== undefined ? { contains } : {}) }
        : undefined;
      const thread = readOwnerThread(options, limit, filter);
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
