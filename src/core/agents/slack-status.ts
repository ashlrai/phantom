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
import { readSlackJournal, type SlackJournalRead } from './slack-journal.js';
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
  journal: { state: SlackJournalRead['state']; ingested: number; ignored: number; lastAt: string | null };
  ready: boolean;
  next?: string;
}

export interface SlackBridgeStatusOptions {
  /** Explicit agent-network.toml path (tests). */
  configPath?: string;
  commsPath?: string;
  runsDir?: string;
  home?: string;
  now?: () => Date;
}

function slackIdentityCount(config: AgentNetworkConfig): number {
  return config.teamIdentities.filter((identity) => identity.channel === 'slack').length;
}

function nextStep(state: AgentNetworkConfig['state'], slack: AgentNetworkConfig['slack'], bridge: SlackBridgeConfig | undefined, slackIds: number): string {
  if (state === 'missing') return 'create ~/.ashlr/agent-network.toml -- see docs/AGENT-NETWORK.md (Slack bridge)';
  if (state === 'invalid') return 'fix ~/.ashlr/agent-network.toml -- the file does not parse as TOML';
  if (slack === 'invalid') return 'fix the [slack] table -- strict parse fails closed; see docs/AGENT-NETWORK.md (Slack bridge)';
  if (bridge === undefined) return 'add a [slack] table with team_id and at least one [[slack.map]] entry';
  if (bridge.botTokenRef === undefined || bridge.appTokenRef === undefined) {
    return 'name phm_ secret references for the bot and app tokens -- the Slack app and its scopes are Mason\'s step';
  }
  if (bridge.map.length === 0) return 'add at least one [[slack.map]] { topic, channel } binding';
  if (slackIds === 0) return 'add [team] identities entries with channel = "slack" for the allowlisted members and agents';
  return 'mapping is ready -- token injection, the socket and the post path ship in the -sec change';
}

export function buildSlackBridgeStatus(options: SlackBridgeStatusOptions = {}): SlackBridgeStatus {
  const now = options.now ?? (() => new Date());
  const config = loadAgentNetworkConfig({ ...(options.configPath ? { path: options.configPath } : {}), ...(options.home ? { home: options.home } : {}) });
  const bridge = config.slack !== undefined && config.slack !== 'invalid' ? config.slack : undefined;
  const journal = readSlackJournal({ ...(options.runsDir ? { runsDir: options.runsDir } : {}), limit: 4096 });
  let ingested = 0;
  let ignored = 0;
  for (const entry of journal.entries) (entry.decision === 'ingested' ? ingested++ : ignored++);
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
    },
    ready,
    next: nextStep(config.state, config.slack, bridge, slackIds),
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

const MAP_NOTE = 'dry run only -- no socket, no Slack API call, no post; token injection and the outbound post path ship in the separately reviewed -sec change';

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
