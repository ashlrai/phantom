/** Pure preparation only. This is not an authenticated ingress or a send receipt. */
import { senderIdFor } from '../comms/imessage-teammate-inbox.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChannelEnvelope } from '../fleet/channel-envelope.js';
import { scrubSecrets } from '../util/scrub.js';
import { agentChannelNameSchema, agentRegistrySchema } from './bus-identity.js';
import { BUS_V2_TEXT_MAX } from './bus-v2-schema.js';
import { parseMasonIdentities } from './leader-network.js';
import { parseTeamIdentities, parseCommsConfirmation, checkSendPolicy } from './channel-policy.js';
const shareSchema = z.object({ kind: z.literal('agent-chat.share'), channel: agentChannelNameSchema,
  thread: z.string().regex(/^(outcome|run):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  text: z.string().min(1).max(BUS_V2_TEXT_MAX).refine(text => text.trim().length > 0),
}).strict();
/** A future caller must be the existing authenticated receiver, not a raw Bus
 * consumer. verifiedSenderId is supplied by that adapter, never by request JSON.
 * Exact structured share request only; ordinary private prose never routes.
 */
export function prepareOwnerChatShare(input: {
  /** Stable, account-scoped physical event ID from trusted adapter, never body JSON. */
  sourceNamespace: string; physicalMessageId: string;
  receipt: Pick<ChannelEnvelope, 'channel' | 'verifiedSenderId' | 'body' | 'receivedAt'>; registry: unknown; configSource: string; commsSource: string;
  now: number; paused: boolean; killed: boolean;
}) {
  const refuse = (reason: string) => ({ status: 'refused' as const, reason });
  if (input.paused || input.killed) return refuse('stopped');
  const receipt = input.receipt;
  if ([input.sourceNamespace, input.physicalMessageId].some(value =>
    typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) || scrubSecrets(value) !== value)) return refuse('missing-physical-identity');
  if (!['imessage', 'email', 'telegram', 'slack'].includes(receipt.channel)) return refuse('unverified-source-kind');
  if (!parseMasonIdentities(input.configSource).some(identity =>
    identity.channel === receipt.channel && (identity.id === receipt.verifiedSenderId ||
      (receipt.channel === 'imessage' && senderIdFor(identity.id) === receipt.verifiedSenderId)))) return refuse('not-configured-owner');
  const receivedAt = Date.parse(receipt.receivedAt);
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(receivedAt) || receivedAt < 0 ||
      receivedAt > input.now || input.now - receivedAt > 7 * 24 * 60 * 60_000) return refuse('stale-or-invalid-receipt');
  let decoded: unknown;
  try { decoded = JSON.parse(receipt.body); } catch { return refuse('not-explicit-share'); }
  const share = shareSchema.safeParse(decoded), registry = agentRegistrySchema.safeParse(input.registry);
  if (!share.success || !registry.success) return refuse('invalid-request');
  if (scrubSecrets(receipt.body) !== receipt.body ||
      [share.data.channel, share.data.thread, share.data.text].some(value => scrubSecrets(value) !== value)) return refuse('secret-shaped');
  const channel = registry.data.channels.find(row => row.name === share.data.channel);
  if (!channel || !channel.members.length || channel.members.some(handle =>
    !registry.data.identities.some(identity => identity.handle === handle))) return refuse('unknown-or-empty-channel');
  // Recheck every recipient: approving a group name must not bless new members.
  const recipients = [...channel.members].sort().map(handle => `agent:${handle}`);
  if (checkSendPolicy({ channel: 'bus', recipients, external: false,
    teamIdentities: parseTeamIdentities(input.configSource),
    confirmedByMason: parseCommsConfirmation(input.commsSource) }).status !== 'sent') return refuse('recipients-not-approved');
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const source = [input.sourceNamespace, receipt.channel, receipt.verifiedSenderId, input.physicalMessageId];
  return { status: 'prepared' as const, requiresVerifiedIngress: true as const,
    sourceDigest: digest(source), contentDigest: digest([source, share.data, recipients]),
    messageId: `owner-chat-${digest(source).slice(0, 32)}`,
    recipientIds: channel.members.map(handle => registry.data.identities.find(row => row.handle === handle)!.id).sort(),
    channel: channel.name, thread: share.data.thread, text: share.data.text, recipients,
    receivedAt, preparedAt: input.now, recheckPolicyBeforeCommit: true as const, grantsExecutionAuthority: false as const };
}
