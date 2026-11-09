/** Desktop surface for the Comms agent's state: pending reply drafts and the
 * email reply outbox, read live as counts only. Never sends, moves or writes;
 * never returns a draft body, subject, recipient address, file name or path. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { listDrafts } from '../cos/drafts.js';
import { diagnoseEmailDrop, type EmailDiagnosisDeps } from '../comms/email-diagnosis.js';
import { checkIMessagePath } from '../comms/imessage-path-check.js';
import { readImessageAckEvidence } from '../comms/imessage-ack-evidence.js';
import { readEmailOutbox } from '../comms/email-outbox.js';

export const VERSE_FLEET_COMMS_STATUS_PATH = '/api/verse/fleet/comms-status';

export interface FleetCommsStatusApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Email reply outbox. Default: the saved email-drop config's outbox. */
  outboxDir?: string;
  /** Collector seams for tests. */
  emailDiagnosisDeps?: EmailDiagnosisDeps;
  imessagePath?: typeof checkIMessagePath;
  imessageAcks?: typeof readImessageAckEvidence;
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

    let stuckReasons: Record<string, number> = {};
    const collectorDeps = deps.emailDiagnosisDeps ?? {};
    const emailDiagnosis = await diagnoseEmailDrop(runsDir, {
      ...collectorDeps,
      ...(deps.outboxDir === undefined ? {} : {
        readConfig: async () => ({
          state: 'ok' as const, path: '',
          config: { v: 1 as const, inboxDir: deps.outboxDir!, outboxDir: deps.outboxDir!, from: [] },
        }),
      }),
      listOutbox: (dir) => {
        const listing = (collectorDeps.listOutbox ?? readEmailOutbox)(dir);
        const reasons: Record<string, number> = {};
        for (const entry of listing.entries) {
          if (entry.state === 'stuck' && entry.reason !== undefined) {
            reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
          }
        }
        stuckReasons = reasons;
        return listing;
      },
    });
    const emailOutboxSource = emailDiagnosis.config === 'missing' ? 'missing'
      : emailDiagnosis.config !== 'ok' || emailDiagnosis.outbox !== 'ok' || emailDiagnosis.counts === null ? 'degraded'
        : 'healthy';
    const emailOutbox: EmailOutboxStatus | null = emailOutboxSource === 'missing'
      ? { configured: false, queued: 0, drafted: 0, sent: 0, stuck: 0, stuckReasons: {} }
      : emailOutboxSource === 'healthy' && emailDiagnosis.counts
        ? { configured: true, ...emailDiagnosis.counts, stuckReasons }
        : null;

    const generatedAt = now();
    let imessage: { configuration: { state: string; reason: string }; chatDb: { state: string; reason: string }; cursor: { state: string; reason: string }; ackSource: string; lastAckAt: string | null; acks24h: number; nextStep: string | null } | null = null;
    let imessageSource: 'healthy' | 'degraded' = 'healthy';
    try {
      const path = (deps.imessagePath ?? checkIMessagePath)({ runsRoot: runsDir });
      const acks = await (deps.imessageAcks ?? readImessageAckEvidence)(262144, runsDir);
      const fields = [path.configuration, path.chatDb, path.cursor];
      const firstProblem = fields.find((field, index) => field.state !== ['configured', 'readable', 'present'][index]);
      const timestamps = acks.rows.map(row => row.timestamp).filter(at => Number.isFinite(Date.parse(at)) && Date.parse(at) <= generatedAt.getTime());
      const project = ({ state, reason }: { state: string; reason: string }) => ({ state, reason });
      imessage = {
        configuration: project(path.configuration), chatDb: project(path.chatDb), cursor: project(path.cursor),
        ackSource: acks.sourceState, lastAckAt: timestamps.sort().at(-1) ?? null,
        acks24h: timestamps.filter(at => Date.parse(at) >= generatedAt.getTime() - 86_400_000).length,
        nextStep: firstProblem?.nextStep ?? null,
      };
    } catch {
      imessageSource = 'degraded';
    }

    sendJson(res, 200, {
      version: 1,
      generatedAt: generatedAt.toISOString(),
      drafts,
      emailOutbox,
      emailDiagnosis,
      imessage,
      sources: { drafts: draftsSource, emailOutbox: emailOutboxSource, imessage: imessageSource },
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
