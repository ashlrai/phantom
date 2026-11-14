/**
 * Offline status and dry-run mapping reports for the Slack bridge
 * (RQ-AGENTNET-SLACK-1). Reads `agent-network.toml`, `comms.toml` and the local
 * observation journal only -- no socket, no Web API call, no credential read.
 * Token entries report whether a `phm_` reference NAME is configured; the
 * secret itself stays in Phantom Secrets custody and is resolved by the
 * security-reviewed poster at request time.
 */
import {
  loadAgentNetworkConfig, loadCommsConfirmation, slackChannelForTopic, slackThreadRef,
  type AgentNetworkConfig, type SlackBridgeConfig,
} from './slack-network.js';
import { readSlackJournal, type SlackJournalRead, type SlackObservation } from './slack-journal.js';
import { readSlackSendReceipts } from './slack-send-receipts.js';
import { bindSlackReplies, type InboundRequest } from './slack-reply-binding.js';
import {
  evaluateSlackAudience, slackAudienceRecipients, slackSendDecision,
  SLACK_AUDIENCE_GATES, SLACK_MEMBER_CAP,
  type SlackAudienceResult, type SlackAudienceSnapshot,
} from './slack-audience.js';

export interface SlackBridgeStatus {
  v: 1;
  at: string;
  config: { path: string; state: AgentNetworkConfig['state'] };
  slackSection: 'ok' | 'invalid' | 'absent';
  bridge: { id: string; teamId: string; ownUserId: string | null; ownBotId: string | null } | null;
  /** Phantom Secrets reference names -- never values. */
  credentials: { custody: 'phantom-secrets'; botTokenRef: string | null; appTokenRef: string | null };
  mappings: { topic: string; channel: string }[];
  teamIdentities: { slack: number; total: number };
  comms: { confirmedByMason: boolean };
  journal: {
    state: SlackJournalRead['state'];
    ingested: number;
    ignored: number;
    lastAt: string | null;
    /**
     * Ignored events bucketed by reason code: 'unspecified' when the row
     * carries none, 'invalid-reason' when the stored string is not a bounded
     * code (never echoed). Count desc, reason asc, capped rows.
     */
    ignoredReasons?: { reason: string; count: number; lastAt: string }[];
    /** Distinct reason buckets the row cap dropped from `ignoredReasons`. */
    ignoredReasonsOmitted?: number;
  };
  /**
   * Ingested requests bound to same-thread `sent` receipts. An `attempted`
   * send is never an answer; `uncertainSends` counts attempts never confirmed.
   */
  replies: {
    state: 'ok' | 'missing' | 'degraded';
    answered: number;
    unanswered: number;
    oldestUnansweredAt: string | null;
    uncertainSends: number;
    rejected: number;
    futureDated: number;
    unansweredSample: { channelId: string; threadTs: string; messageTs: string; at: string }[];
  };
  ready: boolean;
  /** Offline configuration does not establish a connected bot or receive route. */
  transport: { health: 'unknown'; observedAt: null; probeCommand: string };
  next?: string;
}

export interface SlackBridgeStatusOptions {
  /** Explicit agent-network.toml path (tests). */
  configPath?: string;
  commsPath?: string;
  runsDir?: string;
  /** Slack transport state root holding messages.json (tests). */
  stateRoot?: string;
  home?: string;
  now?: () => Date;
}

function slackIdentityCount(config: AgentNetworkConfig): number {
  return config.teamIdentities.filter((identity) => identity.channel === 'slack').length;
}

function nextStep(state: AgentNetworkConfig['state'], slack: AgentNetworkConfig['slack'], bridge: SlackBridgeConfig | undefined, slackIds: number, ingested: number, ignored: number, topReason: string | undefined): string {
  if (state === 'missing') return 'create ~/.ashlr/agent-network.toml -- see docs/AGENT-NETWORK.md (Slack bridge)';
  if (state === 'invalid') return 'fix ~/.ashlr/agent-network.toml -- the file does not parse as TOML';
  if (slack === 'invalid') return 'fix the [slack] table -- strict parse fails closed; see docs/AGENT-NETWORK.md (Slack bridge)';
  if (bridge === undefined) return 'add a [slack] table with team_id and at least one [[slack.map]] entry';
  if (bridge.botTokenRef === undefined || bridge.appTokenRef === undefined) {
    return 'name phm_ secret references for the bot and app tokens -- the Slack app and its scopes are Mason\'s step';
  }
  if (bridge.map.length === 0) return 'add at least one [[slack.map]] { topic, channel } binding';
  if (slackIds === 0) return 'add [team] identities entries with channel = "slack" for the allowlisted members and agents';
  if (ingested === 0 && ignored > 0) {
    return `ready, but every observed event was ignored (top reason: ${topReason ?? 'unspecified'}); fix that before expecting replies`;
  }
  return 'mapping is ready; run phm channels slack probe --json for authenticated identity, then phm channels slack run --seconds 60 --json';
}

/**
 * Reason codes are static, bounded strings -- the only shape the status
 * surface repeats back. Anything else recorded in the journal is reported as
 * 'invalid-reason' so a malformed line can never echo raw text here.
 */
const IGNORED_REASON_CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const IGNORED_REASONS_MAX_ROWS = 8;

/**
 * Ingested journal rows that carry the ids a reply can bind to, in journal
 * order. Rows without channel/message/thread ids are skipped: they cannot be
 * bound, so callers must treat them as unanswered rather than answered.
 */
export function slackInboundRequests(entries: readonly SlackObservation[]): InboundRequest[] {
  const requests: InboundRequest[] = [];
  for (const entry of entries) {
    if (entry.decision === 'ingested' && entry.channelId && entry.messageTs && entry.threadTs) {
      requests.push({ at: entry.at, channelId: entry.channelId, messageTs: entry.messageTs, threadTs: entry.threadTs });
    }
  }
  return requests;
}

export function buildSlackBridgeStatus(options: SlackBridgeStatusOptions = {}): SlackBridgeStatus {
  const now = options.now ?? (() => new Date());
  const config = loadAgentNetworkConfig({ ...(options.configPath ? { path: options.configPath } : {}), ...(options.home ? { home: options.home } : {}) });
  const bridge = config.slack !== undefined && config.slack !== 'invalid' ? config.slack : undefined;
  const journal = readSlackJournal({ ...(options.runsDir ? { runsDir: options.runsDir } : {}), limit: 4096 });
  let ingested = 0;
  let ignored = 0;
  const requests = slackInboundRequests(journal.entries);
  const reasonRows = new Map<string, { count: number; lastAt: string }>();
  for (const entry of journal.entries) {
    if (entry.decision === 'ingested') {
      ingested++;
    } else {
      ignored++;
      const reason = entry.reason === undefined ? 'unspecified' : IGNORED_REASON_CODE.test(entry.reason) ? entry.reason : 'invalid-reason';
      const row = reasonRows.get(reason);
      if (row === undefined) reasonRows.set(reason, { count: 1, lastAt: entry.at });
      else {
        row.count++;
        if (entry.at > row.lastAt) row.lastAt = entry.at;
      }
    }
  }
  const sortedReasons = [...reasonRows.entries()]
    .map(([reason, row]) => ({ reason, count: row.count, lastAt: row.lastAt }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  const ignoredReasons = sortedReasons.slice(0, IGNORED_REASONS_MAX_ROWS);
  const sends = readSlackSendReceipts(options.stateRoot ? { stateRoot: options.stateRoot } : {});
  const binding = bindSlackReplies({ requests, receipts: sends.receipts, now: now() });
  const unansweredByAge = [...binding.unanswered].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const confirmedByMason = loadCommsConfirmation({ ...(options.commsPath ? { path: options.commsPath } : {}), ...(options.home ? { home: options.home } : {}) });
  const slackIds = slackIdentityCount(config);
  const ready = config.state === 'ok' && bridge !== undefined &&
    bridge.botTokenRef !== undefined && bridge.appTokenRef !== undefined &&
    bridge.map.length > 0 && slackIds > 0;
  return {
    v: 1,
    at: now().toISOString(),
    config: { path: config.path, state: config.state },
    slackSection: config.slack === 'invalid' ? 'invalid' : config.slack === undefined ? 'absent' : 'ok',
    bridge: bridge === undefined ? null : {
      id: bridge.bridgeId, teamId: bridge.teamId,
      ownUserId: bridge.ownUserId ?? null, ownBotId: bridge.ownBotId ?? null,
    },
    credentials: {
      custody: 'phantom-secrets',
      botTokenRef: bridge?.botTokenRef ?? null,
      appTokenRef: bridge?.appTokenRef ?? null,
    },
    mappings: bridge?.map.map((entry) => ({ topic: entry.topic, channel: entry.channel })) ?? [],
    teamIdentities: { slack: slackIds, total: config.teamIdentities.length },
    comms: { confirmedByMason },
    journal: {
      state: journal.state, ingested, ignored,
      lastAt: journal.entries[0]?.at ?? null,
      ignoredReasons,
      ignoredReasonsOmitted: sortedReasons.length - ignoredReasons.length,
    },
    replies: {
      state: journal.state === 'degraded' || sends.state === 'degraded' ? 'degraded'
        : journal.state === 'missing' && sends.state === 'missing' ? 'missing' : 'ok',
      answered: binding.answered.length,
      unanswered: binding.unanswered.length,
      oldestUnansweredAt: unansweredByAge[0]?.at ?? null,
      uncertainSends: sends.receipts.filter((r) => r.state === 'attempted').length,
      rejected: binding.rejected,
      futureDated: binding.futureDated,
      unansweredSample: unansweredByAge.slice(0, 5).map((r) => ({
        channelId: r.channelId, threadTs: r.threadTs, messageTs: r.messageTs, at: r.at,
      })),
    },
    ready,
    transport: { health: 'unknown', observedAt: null, probeCommand: 'phm channels slack probe --json' },
    next: nextStep(config.state, config.slack, bridge, slackIds, ingested, ignored, ignoredReasons[0]?.reason),
  };
}

// ---------------------------------------------------------------------------
// map -- dry-run of the mapping tables and the outbound gate chain
// ---------------------------------------------------------------------------

export interface SlackMapReport {
  v: 1;
  dryRun: true;
  at: string;
  config: { path: string; state: AgentNetworkConfig['state'] };
  bridge: { id: string; teamId: string } | null;
  mappings: { topic: string; channel: string; threadRefExample: string }[];
  /** Present with --topic: where a bus message to that topic would be planned. */
  route?: { topic: string; ok: boolean; channel?: string; reason?: 'unmapped-topic' };
  /** Gates the poster runs before any send, in order. */
  audienceGates: readonly string[];
  /** Present with --snapshot: the evaluated audience and the send-policy verdict. */
  audience?: SlackAudienceResult;
  sendPolicy?: { status: 'sent' | 'drafted' | 'refused'; reason: string };
  comms: { confirmedByMason: boolean };
  memberCap: number;
  note: string;
}

const MAP_NOTE = 'dry run only -- no socket, no Slack API call, no post; authenticated probe/run commands verify the actual execution lane separately';

export function buildSlackMapReport(options: SlackBridgeStatusOptions & {
  topic?: string;
  snapshot?: SlackAudienceSnapshot;
  snapshotChannel?: string;
} = {}): SlackMapReport {
  const now = options.now ?? (() => new Date());
  const config = loadAgentNetworkConfig({ ...(options.configPath ? { path: options.configPath } : {}), ...(options.home ? { home: options.home } : {}) });
  const bridge = config.slack !== undefined && config.slack !== 'invalid' ? config.slack : undefined;
  const confirmedByMason = loadCommsConfirmation({ ...(options.commsPath ? { path: options.commsPath } : {}), ...(options.home ? { home: options.home } : {}) });
  const report: SlackMapReport = {
    v: 1,
    dryRun: true,
    at: now().toISOString(),
    config: { path: config.path, state: config.state },
    bridge: bridge === undefined ? null : { id: bridge.bridgeId, teamId: bridge.teamId },
    mappings: (bridge?.map ?? []).map((entry) => ({
      topic: entry.topic,
      channel: entry.channel,
      threadRefExample: slackThreadRef(bridge!.teamId, entry.channel, '<root_ts>'),
    })),
    audienceGates: SLACK_AUDIENCE_GATES,
    comms: { confirmedByMason },
    memberCap: SLACK_MEMBER_CAP,
    note: MAP_NOTE,
  };
  if (options.topic !== undefined) {
    const channel = bridge === undefined ? undefined : slackChannelForTopic(bridge, options.topic);
    report.route = channel === undefined
      ? { topic: options.topic, ok: false, reason: 'unmapped-topic' }
      : { topic: options.topic, ok: true, channel };
  }
  if (options.snapshot !== undefined && bridge !== undefined) {
    const channelId = options.snapshotChannel ?? (options.topic !== undefined ? slackChannelForTopic(bridge, options.topic) : undefined);
    if (channelId !== undefined) {
      const audience = evaluateSlackAudience(bridge, config.teamIdentities, channelId, options.snapshot);
      report.audience = audience;
      if (audience.status === 'postable') {
        report.sendPolicy = slackSendDecision({
          recipients: slackAudienceRecipients(bridge, options.snapshot),
          teamIdentities: config.teamIdentities,
          external: audience.external,
          confirmedByMason,
        });
      } else {
        report.sendPolicy = { status: 'refused', reason: 'audience evaluation did not prove a team-only channel' };
      }
    }
  }
  return report;
}
