/**
 * Slack bridge configuration (RQ-AGENTNET-SLACK-1).
 *
 * Parses the `[slack]` section of `~/.ashlr/agent-network.toml` and exposes the
 * deterministic mappings the bridge runs on:
 *   bus topic  <-> Slack channel id      ([[slack.map]] entries, both directions)
 *   bus thread <-> Slack root thread_ts  (one opaque ref grammar, parseable both ways)
 *
 * The file holds Slack ids and Phantom Secrets `phm_` reference NAMES only --
 * never a token value. Resolution happens at request time inside the
 * security-reviewed poster; nothing in this module touches the network or a
 * credential. Parsing is strict and fails closed: one malformed key, unknown
 * field, duplicate topic/channel or out-of-grammar id marks the whole `[slack]`
 * section `invalid`, and an `invalid` section configures nothing.
 */
import { parse } from 'smol-toml';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { parseCommsConfirmation, parseTeamIdentities, type TeamIdentity } from './channel-policy.js';

export const AGENT_NETWORK_TOML_MAX_BYTES = 256 * 1024;
export const SLACK_MAP_MAX_ENTRIES = 64;
export const SLACK_DEFAULT_BRIDGE_ID = 'slack';

// Slack-side grammars. Ids are uppercase-alnum with a fixed type letter; ts is
// the canonical `<seconds>.<microseconds>` string and is stored verbatim.
const SLACK_TEAM_ID = /^[TE][A-Z0-9]{2,32}$/;
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{2,32}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,32}$/;
const SLACK_BOT_ID = /^B[A-Z0-9]{2,32}$/;
const SLACK_TS = /^\d{1,20}\.\d{1,10}$/;
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;
const PHM_SECRET_REF = /^phm_[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$/;

export const isSlackTeamId = (v: unknown): v is string => typeof v === 'string' && SLACK_TEAM_ID.test(v);
export const isSlackChannelId = (v: unknown): v is string => typeof v === 'string' && SLACK_CHANNEL_ID.test(v);
export const isSlackUserId = (v: unknown): v is string => typeof v === 'string' && SLACK_USER_ID.test(v);
export const isSlackBotId = (v: unknown): v is string => typeof v === 'string' && SLACK_BOT_ID.test(v);
export const isSlackTs = (v: unknown): v is string => typeof v === 'string' && SLACK_TS.test(v);
export const isBusLabel = (v: unknown): v is string => typeof v === 'string' && BUS_LABEL.test(v);
export const isPhmSecretRef = (v: unknown): v is string => typeof v === 'string' && PHM_SECRET_REF.test(v);
/** An author id a Socket Mode event can carry: a user (U/W…) or a bot (B…). */
export const isSlackAuthorId = (v: unknown): v is string => isSlackUserId(v) || isSlackBotId(v);

export interface SlackMapEntry {
  /** Bus routing label this channel is bound to (envelope `to`). */
  topic: string;
  /** Slack channel id (C… public or G… private). */
  channel: string;
}

export interface SlackBridgeConfig {
  /** origin_bridge stamped on envelopes this bridge posts; also its loop-guard key. */
  bridgeId: string;
  /** Workspace id every inbound event and member binding must match. */
  teamId: string;
  /** The bridge bot's own Slack user id; its events are dropped (loop guard). */
  ownUserId?: string;
  /** The bridge bot's bot id as seen on `message`/`bot_message` events. */
  ownBotId?: string;
  /** Phantom Secrets reference NAME for the xoxb bot token -- a name, never a value. */
  botTokenRef?: string;
  /** Phantom Secrets reference NAME for the xapp app-level token (Socket Mode). */
  appTokenRef?: string;
  map: SlackMapEntry[];
}

export type SlackSection = SlackBridgeConfig | 'invalid' | undefined;

export interface AgentNetworkConfig {
  path: string;
  /** `missing` no file; `invalid` unparseable or oversized TOML; `ok` parsed. */
  state: 'missing' | 'invalid' | 'ok';
  teamIdentities: TeamIdentity[];
  slack: SlackSection;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SLACK_KEYS = new Set(['bridge_id', 'team_id', 'own_user_id', 'own_bot_id', 'bot_token_ref', 'app_token_ref', 'map']);
const MAP_KEYS = new Set(['topic', 'channel']);

/**
 * Strict `[slack]` parse. `undefined` means the table is absent; `null` means
 * present but any rule failed (caller surfaces `invalid`). Unknown keys fail:
 * silently ignoring a misspelled key would configure something Mason did not write.
 */
function parseSlackSection(doc: Record<string, unknown>): SlackBridgeConfig | null | undefined {
  if (!Object.hasOwn(doc, 'slack')) return undefined;
  const slack = doc['slack'];
  if (!record(slack)) return null;
  if (Object.keys(slack).some((key) => !SLACK_KEYS.has(key))) return null;
  if (!isSlackTeamId(slack['team_id'])) return null;
  if (Object.hasOwn(slack, 'bridge_id') && !isBusLabel(slack['bridge_id'])) return null;
  if (Object.hasOwn(slack, 'own_user_id') && !isSlackUserId(slack['own_user_id'])) return null;
  if (Object.hasOwn(slack, 'own_bot_id') && !isSlackBotId(slack['own_bot_id'])) return null;
  if (Object.hasOwn(slack, 'bot_token_ref') && !isPhmSecretRef(slack['bot_token_ref'])) return null;
  if (Object.hasOwn(slack, 'app_token_ref') && !isPhmSecretRef(slack['app_token_ref'])) return null;
  const rawMap = slack['map'] ?? [];
  if (!Array.isArray(rawMap) || rawMap.length > SLACK_MAP_MAX_ENTRIES) return null;
  const map: SlackMapEntry[] = [];
  const topics = new Set<string>();
  const channels = new Set<string>();
  for (const entry of rawMap) {
    if (!record(entry) || Object.keys(entry).some((key) => !MAP_KEYS.has(key)) ||
        !isBusLabel(entry['topic']) || !isSlackChannelId(entry['channel'])) return null;
    const topic = entry['topic'];
    const channel = entry['channel'];
    if (topics.has(topic) || channels.has(channel)) return null;
    topics.add(topic);
    channels.add(channel);
    map.push({ topic, channel });
  }
  return {
    bridgeId: typeof slack['bridge_id'] === 'string' ? slack['bridge_id'] : SLACK_DEFAULT_BRIDGE_ID,
    teamId: slack['team_id'],
    ...(isSlackUserId(slack['own_user_id']) ? { ownUserId: slack['own_user_id'] } : {}),
    ...(isSlackBotId(slack['own_bot_id']) ? { ownBotId: slack['own_bot_id'] } : {}),
    ...(isPhmSecretRef(slack['bot_token_ref']) ? { botTokenRef: slack['bot_token_ref'] } : {}),
    ...(isPhmSecretRef(slack['app_token_ref']) ? { appTokenRef: slack['app_token_ref'] } : {}),
    map,
  };
}

export function agentNetworkTomlPath(home?: string): string {
  return join(home ?? ashlrHome(), 'agent-network.toml');
}

export function commsTomlPath(home?: string): string {
  return join(home ?? ashlrHome(), 'comms.toml');
}

/**
 * Read `~/.ashlr/agent-network.toml` (or an explicit path). The TOML is parsed
 * once; `[team]` keeps the existing fail-closed semantics (malformed input is
 * an empty allowlist) and `[slack]` is reported separately so a status surface
 * can tell "not configured" apart from "present but broken".
 */
export function loadAgentNetworkConfig(options: { path?: string; home?: string } = {}): AgentNetworkConfig {
  const path = options.path ?? agentNetworkTomlPath(options.home);
  const missing: AgentNetworkConfig = { path, state: 'missing', teamIdentities: [], slack: undefined };
  const read = readPrivateFileCapped(path, AGENT_NETWORK_TOML_MAX_BYTES);
  if (read === null || read.truncated) return { ...missing, state: read === null ? 'missing' : 'invalid' };
  const teamIdentities = parseTeamIdentities(read.text);
  let doc: unknown;
  try {
    doc = parse(read.text, { unsafeKeyBehaviour: 'throw' });
  } catch {
    return { path, state: 'invalid', teamIdentities: [], slack: undefined };
  }
  if (!record(doc)) return { path, state: 'invalid', teamIdentities: [], slack: undefined };
  const slack = parseSlackSection(doc);
  return { path, state: 'ok', teamIdentities, slack: slack === null ? 'invalid' : slack };
}

/** `comms.toml` confirmation. Absent, malformed or non-boolean means not confirmed. */
export function loadCommsConfirmation(options: { path?: string; home?: string } = {}): boolean {
  const read = readPrivateFileCapped(options.path ?? commsTomlPath(options.home), AGENT_NETWORK_TOML_MAX_BYTES);
  return read !== null && !read.truncated && parseCommsConfirmation(read.text);
}

// ---------------------------------------------------------------------------
// Topic <-> channel and thread <-> thread_ts mappings
// ---------------------------------------------------------------------------

export function slackChannelForTopic(config: SlackBridgeConfig, topic: string): string | undefined {
  return config.map.find((entry) => entry.topic === topic)?.channel;
}

export function slackTopicForChannel(config: SlackBridgeConfig, channelId: string): string | undefined {
  return config.map.find((entry) => entry.channel === channelId)?.topic;
}

/**
 * Opaque thread reference shared by `channel_ref` and `body.thread`:
 * `slack:<teamId>:<channelId>:<rootTs>`. A channel-root message starts a new
 * thread (root = its own `ts`); a reply carries the Slack `thread_ts` root.
 * Bounded: worst case is ~60 chars, far under the 128-char label cap.
 */
export function slackThreadRef(teamId: string, channelId: string, rootTs: string): string {
  return `slack:${teamId}:${channelId}:${rootTs}`;
}

export interface ParsedSlackThreadRef { teamId: string; channelId: string; rootTs: string }

/** Inverse of {@link slackThreadRef}; `undefined` for any other shape. */
export function parseSlackThreadRef(ref: unknown): ParsedSlackThreadRef | undefined {
  if (typeof ref !== 'string' || ref.length > 128) return undefined;
  const parts = ref.split(':');
  if (parts.length !== 4 || parts[0] !== 'slack' ||
      !isSlackTeamId(parts[1]) || !isSlackChannelId(parts[2]) || !isSlackTs(parts[3])) return undefined;
  return { teamId: parts[1]!, channelId: parts[2]!, rootTs: parts[3]! };
}

/** Slack ids the bridge treats as itself: its user id and its bot id. */
export function isSlackSelfId(config: SlackBridgeConfig, id: string | undefined): boolean {
  return id !== undefined && (id === config.ownUserId || id === config.ownBotId);
}

/** Slack ids allowed to author bus messages or count as a known bot member. */
export function isSlackTeamIdentity(teamIdentities: readonly TeamIdentity[], id: string): boolean {
  return teamIdentities.some((identity) => identity.channel === 'slack' && identity.id === id);
}
