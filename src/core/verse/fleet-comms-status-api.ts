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
import { buildCommsCutoverReadiness, type CommsCutoverReport } from '../comms/cutover-readiness.js';
import { readEmailOutbox } from '../comms/email-outbox.js';
import { readTeammateLatency, type TeammateLatencySummary } from '../comms/teammate-reply-latency.js';
import { readLocalSendPolicy } from '../agents/send-gate.js';
import { readChannelHealth, type ChannelHealthReport } from '../fleet/channel-health.js';
import { sanitizeIdentityText } from '../fleet/runtime-identity.js';

export const VERSE_FLEET_COMMS_STATUS_PATH = '/api/verse/fleet/comms-status';
const CHANNEL_HEALTH_TIMEOUT_MS = 5_000;

export interface FleetCommsStatusApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Email reply outbox. Default: the saved email-drop config's outbox. */
  outboxDir?: string;
  /** Collector seams for tests. */
  emailDiagnosisDeps?: EmailDiagnosisDeps;
  imessagePath?: typeof checkIMessagePath;
  imessageAcks?: typeof readImessageAckEvidence;
  /** Teammate (Dot) reply-latency seam for tests. Default reads teammates.jsonl under runsDir with the request clock. */
  teammateLatency?: (now: number) => TeammateLatencySummary | Promise<TeammateLatencySummary>;
  /** Off-Grok-Bot cutover seam for tests. Default: buildCommsCutoverReadiness over runsDir. */
  cutover?: (runsDir: string) => Promise<CommsCutoverReport>;
  /** Send-policy reader (read-only). Default: ~/.ashlr/comms.toml and agent-network.toml. */
  sendPolicy?: typeof readLocalSendPolicy;
  /** Slack/iMessage bridge health reader. Default: readChannelHealth() on the request clock. */
  channelHealth?: () => Promise<ChannelHealthReport>;
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

    // Counts and minutes only: never text, sender, handle or rowid.
    let teammate: Record<string, unknown> | null = null;
    let teammateSource: 'healthy' | 'missing' | 'degraded' = 'healthy';
    try {
      const t = await (deps.teammateLatency ?? ((at: number) => readTeammateLatency({ runsDir, now: () => at })))(generatedAt.getTime());
      teammate = {
        windowHours: t.windowHours, targetMinutes: t.targetMinutes, texts: t.texts, answered: t.answered,
        unanswered: t.unanswered, ignorable: t.ignorable, medianMinutes: t.medianMinutes, p90Minutes: t.p90Minutes,
        maxMinutes: t.maxMinutes, withinTarget: t.withinTarget,
        oldestUnanswered: t.oldestUnanswered === null ? null : { ageMinutes: t.oldestUnanswered.ageMinutes },
        latestTextAt: t.latestTextAt ?? null,
        sourceState: t.sourceState,
      };
      teammateSource = t.sourceState;
    } catch {
      teammateSource = 'degraded';
    }

    // A projection of the cutover report: states, reason codes and next-step commands only.
    let cutover: { overall: { state: string; blockers: string[] }; capabilities: Record<string, { state: string; reason: string; nextStep: string }> } | null = null;
    let cutoverSource: 'healthy' | 'degraded' = 'healthy';
    try {
      const report = await (deps.cutover ?? ((dir: string) => buildCommsCutoverReadiness({ runsDir: dir })))(runsDir);
      cutover = {
        overall: { state: report.overall.state, blockers: [...report.overall.blockers] },
        capabilities: Object.fromEntries(Object.entries(report.capabilities)
          .map(([id, c]) => [id, { state: c.state, reason: c.reason, nextStep: c.nextStep }])),
      };
    } catch {
      cutoverSource = 'degraded';
    }

    // Counts and channel names only: never identity ids, addresses or the home path.
    let sendPolicy: { confirmed: boolean; teamIdentities: number; channels: string[] } | null = null;
    let sendPolicySource: 'healthy' | 'degraded' = 'healthy';
    try {
      const policy = (deps.sendPolicy ?? readLocalSendPolicy)();
      sendPolicy = {
        confirmed: policy.confirmedByMason === true,
        teamIdentities: policy.teamIdentities.length,
        channels: [...new Set(policy.teamIdentities.map(identity => String(identity.channel)))].sort(),
      };
    } catch {
      sendPolicySource = 'degraded';
    }

    // The bridge health report as returned, except runtimeHost redacted like
    // runtime-identity output. A throw or a read past the timeout degrades the
    // field to 'unavailable'; it never fails the route.
    let channelHealth: ChannelHealthReport | { schemaVersion: 1; asOf: string; channels: never[]; error: 'unavailable' };
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const report = await Promise.race([
        (deps.channelHealth ?? (() => readChannelHealth({ now: () => generatedAt })))(),
        new Promise<never>((_resolve, reject) => {
          healthTimer = setTimeout(() => reject(new Error('channel-health-timeout')), CHANNEL_HEALTH_TIMEOUT_MS);
        }),
      ]);
      const home = homedir();
      channelHealth = {
        ...report,
        channels: report.channels.map((channel) => ({
          ...channel,
          runtimeHost: channel.runtimeHost === null ? null : sanitizeIdentityText(channel.runtimeHost, home),
        })),
      };
    } catch {
      channelHealth = { schemaVersion: 1, asOf: generatedAt.toISOString(), channels: [], error: 'unavailable' };
    } finally {
      if (healthTimer !== undefined) clearTimeout(healthTimer);
    }

    sendJson(res, 200, {
      version: 1,
      generatedAt: generatedAt.toISOString(),
      drafts,
      emailOutbox,
      emailDiagnosis,
      imessage,
      teammate,
      cutover,
      sendPolicy,
      sources: { drafts: draftsSource, emailOutbox: emailOutboxSource, imessage: imessageSource, teammate: teammateSource, cutover: cutoverSource, sendPolicy: sendPolicySource },
      channelHealth,
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
