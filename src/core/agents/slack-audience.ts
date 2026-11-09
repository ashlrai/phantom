/**
 * Slack outbound audience evaluation, routing plan and rate-limit backoff
 * (RQ-AGENTNET-SLACK-1). Pure decisions only -- the `conversations.info`,
 * `conversations.members`, `users.info` and `chat.postMessage` calls that feed
 * these inputs land in the separately reviewed `-sec` change.
 *
 * Posting rule (task + research doc): a bus message bound for a mapped topic
 * may post only when the channel's audience is provably team-only. That means:
 *   - the conversation is not shared in any form (`is_shared`,
 *     `is_ext_shared`, `is_pending_ext_shared` -- Slack Connect is refused),
 *   - it is a real channel, never a DM/MPIM,
 *   - `context_team_id`, when present, is our own workspace,
 *   - every member is provably internal: a `team_id` or `enterprise_id`
 *     binding equal to the configured workspace, not a guest
 *     (`is_restricted`/`is_ultra_restricted`), not `is_stranger`, not
 *     `deleted`, and on the explicit `[team]` allowlist -- bots only when
 *     allowlisted (unknown bots are refused), the bridge's own ids excepted.
 * Anything that cannot be proved comes back `uncertain`, which the send path
 * must treat exactly like a refusal: drafts only, fail closed.
 *
 * The snapshot shapes mirror the Slack Web API objects but are supplied by the
 * caller, so tests and `channels slack map --snapshot` run fully offline.
 */
import { checkSendPolicy, shouldIngestFromBridge, type TeamIdentity } from './channel-policy.js';
import { BUS_V2_TEXT_MAX } from './bus-v2-schema.js';
import type { BusEnvelope } from '../fleet/bus-envelope.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  isSlackAuthorId, isSlackSelfId, isSlackTeamIdentity, parseSlackThreadRef,
  slackChannelForTopic, type SlackBridgeConfig,
} from './slack-network.js';

// ---------------------------------------------------------------------------
// Audience snapshot (caller supplies; Slack API-shaped, ids and flags only)
// ---------------------------------------------------------------------------

export interface SlackConversationSnapshot {
  /** conversations.info channel id; when present it must equal the queried channel. */
  id?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  context_team_id?: string;
}

export interface SlackMemberSnapshot {
  id: string;
  team_id?: string;
  enterprise_id?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  is_stranger?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
}

export interface SlackAudienceSnapshot {
  conversation: SlackConversationSnapshot;
  /** Fully paginated membership. Over {@link SLACK_MEMBER_CAP} is unprovable. */
  members: SlackMemberSnapshot[];
  /** Authenticated API pagination ended, not merely a caller's first page. */
  complete?: boolean;
}

export const SLACK_MEMBER_CAP = 512;

export type SlackAudienceRefusal =
  | 'mismatched-channel'
  | 'shared-channel'
  | 'direct-message'
  | 'wrong-workspace'
  | 'external-member'
  | 'guest-member'
  | 'deleted-member'
  | 'unknown-bot'
  | 'member-not-allowlisted'
  | 'unproved-member';

export type SlackAudienceUncertainty = 'empty-membership' | 'membership-incomplete';

export interface SlackAudienceResult {
  status: 'postable' | 'refused' | 'uncertain';
  reason?: SlackAudienceRefusal | SlackAudienceUncertainty;
  /** Member ids that failed the audience check (bounded; ids are metadata). */
  refusedMembers?: string[];
  memberCount: number;
  /** True when an external audience indicator was observed. */
  external: boolean;
}

function memberBinding(member: SlackMemberSnapshot): string | undefined {
  return member.team_id;
}

function memberVerdict(
  member: SlackMemberSnapshot,
  config: SlackBridgeConfig,
  teamIdentities: readonly TeamIdentity[],
): SlackAudienceRefusal | null {
  if (!isSlackAuthorId(member.id)) return 'unproved-member';
  if (member.deleted === true) return 'deleted-member';
  if (member.is_stranger === true) return 'external-member';
  if (member.is_restricted === true || member.is_ultra_restricted === true) return 'guest-member';
  const binding = memberBinding(member);
  if (binding === undefined) return 'unproved-member';
  if (binding !== config.teamId) return 'external-member';
  // Internal to the workspace -- but posting still needs the explicit allowlist:
  // every human member, and every bot member other than the bridge itself.
  if (isSlackSelfId(config, member.id)) return null;
  const allowlisted = isSlackTeamIdentity(teamIdentities, member.id);
  if (member.is_bot === true || member.is_app_user === true) return allowlisted ? null : 'unknown-bot';
  return allowlisted ? null : 'member-not-allowlisted';
}

/**
 * Decide whether the mapped channel's observed audience permits a team post.
 * Refusals and uncertainties are deterministic: the first failing member id in
 * snapshot order is reported, and every refusal reason is a static string.
 */
export function evaluateSlackAudience(
  config: SlackBridgeConfig,
  teamIdentities: readonly TeamIdentity[],
  channelId: string,
  snapshot: SlackAudienceSnapshot,
): SlackAudienceResult {
  const conversation = snapshot.conversation;
  if (conversation.id !== undefined && conversation.id !== channelId) {
    return { status: 'refused', reason: 'mismatched-channel', memberCount: snapshot.members.length, external: false };
  }
  if ((conversation.is_im === true || conversation.is_mpim === true) && !channelId.startsWith('D')) {
    return { status: 'refused', reason: 'direct-message', memberCount: snapshot.members.length, external: false };
  }
  if (conversation.is_shared === true || conversation.is_ext_shared === true || conversation.is_pending_ext_shared === true) {
    return { status: 'refused', reason: 'shared-channel', memberCount: snapshot.members.length, external: true };
  }
  if (conversation.context_team_id !== undefined && conversation.context_team_id !== config.teamId) {
    return { status: 'refused', reason: 'wrong-workspace', memberCount: snapshot.members.length, external: true };
  }
  const members = snapshot.members;
  if (snapshot.complete === false) {
    return { status: 'uncertain', reason: 'membership-incomplete', memberCount: members.length, external: false };
  }
  if (members.length === 0) {
    return { status: 'uncertain', reason: 'empty-membership', memberCount: 0, external: false };
  }
  if (members.length > SLACK_MEMBER_CAP) {
    return { status: 'uncertain', reason: 'membership-incomplete', memberCount: members.length, external: false };
  }
  const refused: { member: string; reason: SlackAudienceRefusal }[] = [];
  let external = false;
  for (const member of members) {
    const verdict = memberVerdict(member, config, teamIdentities);
    if (verdict === 'external-member' || verdict === 'guest-member') external = true;
    if (verdict !== null && refused.every((row) => row.member !== member.id)) {
      refused.push({ member: member.id, reason: verdict });
    }
  }
  if (refused.length > 0) {
    const first = refused[0]!;
    return {
      status: 'refused',
      reason: first.reason,
      refusedMembers: refused.slice(0, 32).map((row) => row.member),
      memberCount: members.length,
      external,
    };
  }
  return { status: 'postable', memberCount: members.length, external: false };
}

/** Member ids minus the bridge itself -- the recipient list for checkSendPolicy. */
export function slackAudienceRecipients(
  config: SlackBridgeConfig,
  snapshot: SlackAudienceSnapshot,
): string[] {
  const ids = snapshot.members
    .map((member) => member.id)
    .filter((id) => !isSlackSelfId(config, id));
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Outbound routing plan (bus envelope -> Slack post shape)
// ---------------------------------------------------------------------------

export interface SlackOutboundPlan {
  /** Mapped Slack channel id. */
  channel: string;
  /** Root thread_ts for a reply, absent for a new channel-root post. */
  threadTs?: string;
  /** Body text as it would be posted (note/context bodies only). */
  text: string;
  /** Broadcast is never enabled. */
  broadcast: false;
  /** The topic the envelope was routed by (envelope `to`). */
  topic: string;
}

export type SlackOutboundRefusal =
  | 'invalid-envelope'
  | 'private-source'
  | 'own-bridge'
  | 'external-envelope'
  | 'unmapped-topic'
  | 'foreign-thread-ref'
  | 'unsupported-body-kind'
  | 'empty-text'
  | 'oversize-text'
  | 'secret-shaped-text';

export type SlackOutboundDecision =
  | { ok: true; plan: SlackOutboundPlan }
  | { ok: false; reason: SlackOutboundRefusal };

/**
 * Plan the Slack post for a bus envelope addressed to a mapped topic. Pure:
 * resolves the channel and thread and extracts the only postable body kinds
 * (`note`, `context`). The loop guard drops envelopes this bridge originated;
 * an envelope marked `external` is never reposted; a `body.thread` carrying a
 * foreign or other-channel `slack:` ref is refused outright while unrecognized
 * thread labels simply post at the channel root.
 */
export function slackOutboundPlan(
  envelope: BusEnvelope,
  config: SlackBridgeConfig,
): SlackOutboundDecision {
  if (envelope === null || typeof envelope !== 'object') return { ok: false, reason: 'invalid-envelope' };
  // iMessage bodies remain local. Only an explicitly authored local result or
  // summary may be posted; connecting channels is not permission to mirror mail.
  if (envelope.channel === 'imessage' || envelope.channel === 'email') return { ok: false, reason: 'private-source' };
  if (!shouldIngestFromBridge(envelope, config.bridgeId)) return { ok: false, reason: 'own-bridge' };
  if (envelope.external === true) return { ok: false, reason: 'external-envelope' };
  const channel = slackChannelForTopic(config, envelope.to);
  if (channel === undefined) return { ok: false, reason: 'unmapped-topic' };
  const body = envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'unsupported-body-kind' };
  const kind = (body as Record<string, unknown>)['kind'];
  if (kind !== 'note' && kind !== 'context') return { ok: false, reason: 'unsupported-body-kind' };
  const text = (body as Record<string, unknown>)['text'];
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'empty-text' };
  if (text.length > BUS_V2_TEXT_MAX) return { ok: false, reason: 'oversize-text' };
  if (scrubSecrets(text) !== text) return { ok: false, reason: 'secret-shaped-text' };
  let threadTs: string | undefined;
  const thread = (body as Record<string, unknown>)['thread'];
  if (typeof thread === 'string') {
    const ref = parseSlackThreadRef(thread);
    if (ref !== undefined) {
      if (ref.teamId !== config.teamId || ref.channelId !== channel) return { ok: false, reason: 'foreign-thread-ref' };
      threadTs = ref.rootTs;
    }
  }
  return { ok: true, plan: { channel, ...(threadTs ? { threadTs } : {}), text, broadcast: false, topic: envelope.to } };
}

/** Gates the -sec poster runs, in order, for `channels slack map --topic`. */
export const SLACK_AUDIENCE_GATES = [
  'conversations.info:not-im-or-mpim',
  'conversations.info:not-shared(is_shared,is_ext_shared,is_pending_ext_shared)',
  'conversations.info:context_team_id-matches',
  'conversations.members:fully-paginated',
  'members:team_id-or-enterprise_id-matches',
  'members:no-guests-strangers-deleted',
  'members:no-unknown-bots',
  'members:all-allowlisted',
  'send-policy:checkSendPolicy',
] as const;

/** Shared send policy for a proved audience; `recipients` come from the member list. */
export function slackSendDecision(input: {
  recipients: readonly string[];
  teamIdentities: readonly TeamIdentity[];
  external: boolean;
  confirmedByMason: boolean;
}): ReturnType<typeof checkSendPolicy> {
  return checkSendPolicy({ channel: 'slack', ...input });
}

// ---------------------------------------------------------------------------
// Rate-limit backoff (429 Retry-After + exponential full jitter)
// ---------------------------------------------------------------------------

export const SLACK_BACKOFF_BASE_MS = 1_000;
export const SLACK_BACKOFF_CAP_MS = 60_000;
export const SLACK_RETRY_AFTER_CAP_SECONDS = 300;
export const SLACK_BACKOFF_MAX_ATTEMPTS = 8;

/**
 * Delay before retry `attempt` (0-based) of a rate-limited Web API call.
 * A `Retry-After` hint is authoritative up to {@link SLACK_RETRY_AFTER_CAP_SECONDS}
 * (a workspace asking for longer stalls the bounded queue instead); otherwise
 * full-jitter exponential backoff, `random()` injectable for determinism.
 */
export function slackBackoffMs(input: {
  attempt: number;
  retryAfterSeconds?: number;
  random?: () => number;
}): number {
  const random = input.random ?? Math.random;
  const attempt = Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? input.attempt : 0;
  if (typeof input.retryAfterSeconds === 'number' && Number.isFinite(input.retryAfterSeconds) && input.retryAfterSeconds >= 0) {
    const honored = Math.min(input.retryAfterSeconds, SLACK_RETRY_AFTER_CAP_SECONDS);
    return Math.floor(honored * 1000 + random() * 250);
  }
  const ceiling = Math.min(SLACK_BACKOFF_CAP_MS, SLACK_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 10));
  return Math.floor(random() * ceiling);
}

/** Retry budget: a bounded queue gives up after this many deliveries. */
export function slackRetriesExhausted(attempt: number): boolean {
  return attempt >= SLACK_BACKOFF_MAX_ATTEMPTS;
}
