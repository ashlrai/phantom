/** Desktop surface for the Comms agent's state: pending reply drafts and the
 * email reply outbox, read live as counts only. Never sends, moves or writes;
 * never returns a draft body, subject, recipient address, file name or path. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { listDrafts } from '../cos/drafts.js';
import { readEmailDropConfig } from '../comms/email-drop-config.js';
import { readEmailOutbox } from '../comms/email-outbox.js';

export const VERSE_FLEET_COMMS_STATUS_PATH = '/api/verse/fleet/comms-status';

export interface FleetCommsStatusApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Email reply outbox. Default: the saved email-drop config's outbox. */
  outboxDir?: string;
  /** Clock seam for tests; stamps generatedAt. */
  now?: () => Date;
}

interface DraftsStatus {
  pending: number;
  oldestPendingAt: string | null;
}

interface EmailOutboxStatus {
  configured: boolean;
  queued: number;
  drafted: number;
  sent: number;
  stuck: number;
  stuckReasons: Record<string, number>;
}

const defaultRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

async function readDrafts(runsDir: string): Promise<DraftsStatus> {
  const pending = await listDrafts({ runsDir, status: 'pending' });
  let oldestPendingAt: string | null = null;
  for (const draft of pending) {
    if (oldestPendingAt === null || draft.createdAt < oldestPendingAt) oldestPendingAt = draft.createdAt;
  }
  return { pending: pending.length, oldestPendingAt };
}

/** The outbox dir the saved email-drop config points at, mirroring fleet-cos-api. */
async function savedOutboxDir(runsDir: string): Promise<{ dir?: string; state: 'ok' | 'missing' | 'invalid' }> {
  const saved = await readEmailDropConfig(runsDir);
  if (saved.state === 'ok' && saved.config) {
    return { dir: saved.config.outboxDir ?? join(saved.config.inboxDir, '..', 'outbox'), state: 'ok' };
  }
  return { state: saved.state === 'missing' ? 'missing' : 'invalid' };
}

function readOutbox(dir: string): EmailOutboxStatus {
  const listing = readEmailOutbox(dir);
  const stuckReasons: Record<string, number> = {};
  for (const entry of listing.entries) {
    if (entry.state === 'stuck' && entry.reason !== undefined) {
      stuckReasons[entry.reason] = (stuckReasons[entry.reason] ?? 0) + 1;
    }
  }
  return { configured: true, ...listing.counts, stuckReasons };
}

export function createFleetCommsStatusApi(deps: FleetCommsStatusApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const runsDir = deps.runsDir ?? defaultRunsDir();

  async function status(res: Parameters<ApiModule>[2]): Promise<void> {
    let drafts: DraftsStatus | null = null;
    let draftsSource: 'healthy' | 'degraded' = 'healthy';
    try {
      drafts = await readDrafts(runsDir);
    } catch {
      draftsSource = 'degraded';
    }

    let emailOutbox: EmailOutboxStatus | null = null;
    let emailOutboxSource: 'healthy' | 'missing' | 'degraded' = 'healthy';
    let outboxDir = deps.outboxDir;
    if (outboxDir === undefined) {
      let saved: { dir?: string; state: 'ok' | 'missing' | 'invalid' };
      try {
        saved = await savedOutboxDir(runsDir);
      } catch {
        saved = { state: 'invalid' };
      }
      if (saved.state === 'ok') outboxDir = saved.dir;
      else emailOutboxSource = saved.state === 'missing' ? 'missing' : 'degraded';
    }
    if (outboxDir !== undefined) {
      try {
        emailOutbox = readOutbox(outboxDir);
      } catch {
        emailOutboxSource = 'degraded';
      }
    } else if (emailOutboxSource === 'missing') {
      emailOutbox = { configured: false, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} };
    }

    sendJson(res, 200, {
      version: 1,
      generatedAt: now().toISOString(),
      drafts,
      emailOutbox,
      sources: { drafts: draftsSource, emailOutbox: emailOutboxSource },
    });
  }

  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_COMMS_STATUS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    await status(res);
    return true;
  };
}

export const handleFleetCommsStatusApi: ApiModule = createFleetCommsStatusApi();
