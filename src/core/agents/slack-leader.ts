/** Trusted Socket Mode owner adapter for the existing Leader network. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realHome } from '../real-home.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { leaderInboxAppender, leaderNetworkSources, noteUnifiedOwner, readLeaderNetworkConfig, type LeaderRuntimeOptions } from './leader-network-runtime.js';
import { createLeaderNetwork, parseMasonIdentities } from './leader-network.js';
import { loadAgentNetworkConfig, isSlackUserId, parseSlackThreadRef } from './slack-network.js';
import { createSlackApi, deliverSlackEnvelope, type SlackCall, type SlackDeliveryPolicy } from './slack-transport.js';
import { parseCommsConfirmation, type DeliverResult, type TeamIdentity } from './channel-policy.js';
import { slackEventToBus, type SlackInboundDecision, type SlackIngestContext } from './slack-inbound.js';
import type { LeaderChannelAdapter } from './leader-channel-adapter.js';

/** Owner "status" auto-answer, injected by the socket wiring: this module is
 * inside the Tier-1 closure, so it cannot import the status composer itself. */
export interface SlackStatusReply {
  /** Exact short owner asks only; anything else stays with the Leader. */
  ask(text: string): boolean;
  /** Compose the answer for a gated ask. */
  compose(runsDir: string, now: Date): Promise<string>;
  /** Posted when compose throws or misses its deadline. */
  readonly fallback: string;
}

/** Outcome of the in-thread status answer; on `answered: false` the ask was
 * written to MASON-INBOX as a P0 order instead (today's behavior). */
export interface SlackStatusAnswer { answered: boolean; reason: string }

export interface SlackLeaderOptions extends LeaderRuntimeOptions {
  call?: SlackCall; signal?: AbortSignal;
  /** Test seam for the owner "status" auto-answer; unset leaves asks to the Leader. */
  statusReply?: SlackStatusReply;
}

/** Compose the existing authenticated Slack mapper, durable Leader routing and
 * journaled same-thread delivery without putting credentials in the adapter. */
export function createSlackLeaderAdapter(options: SlackLeaderOptions = {}): LeaderChannelAdapter<unknown, SlackIngestContext, SlackInboundDecision> {
  return {
    id: 'slack',
    normalize: slackEventToBus,
    route: message => ingestSlackLeaderEnvelope(message, options),
    deliver: (identity, message) => deliverSlackLeaderMessage(identity, message, options),
  };
}

/** Config is trusted host state, never an identity field supplied in a Slack message. */
export function readSlackDeliveryPolicy(options: LeaderRuntimeOptions = {}): SlackDeliveryPolicy | undefined {
  const home = realHome();
  const configDir = options.configDir ?? join(home ?? '/owner-home-unavailable', '.ashlr');
  const parsed = loadAgentNetworkConfig({ path: join(configDir, 'agent-network.toml') });
  if (parsed.state !== 'ok' || !parsed.slack || parsed.slack === 'invalid') return undefined;
  const sources = readLeaderNetworkConfig(options);
  return { config: parsed.slack, teamIdentities: parsed.teamIdentities, confirmedByMason: parseCommsConfirmation(sources.commsSource) };
}

export function configuredSlackCall(config: SlackDeliveryPolicy['config'], signal?: AbortSignal): SlackCall {
  return createSlackApi({ config, signal, resolveCredential: reference =>
    /^phm_SLACK_(?:AGENTNET_)?(?:BOT|APP)_TOKEN$/.test(reference) ? process.env[reference.slice(4)] : undefined });
}

/** Called only with a mapper result from the authenticated socket, before peer-bus append. */
export async function ingestSlackLeaderEnvelope(message: BusEnvelope, options: SlackLeaderOptions = {}): Promise<{ owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> }> {
  const checked = validateBusEnvelope(message);
  if (!checked.ok || message.channel !== 'slack' || message.external !== false || message.sender?.human !== true ||
      message.sender.vendor !== 'slack' || !isSlackUserId(message.sender.agent_id) || message.from !== `slack:${message.sender.agent_id}`) return { owned: false, durable: false };
  const identity: TeamIdentity = { channel: 'slack', id: message.sender.agent_id };
  const sources = leaderNetworkSources(options);
  if (!parseMasonIdentities(sources.configSource).some(owner => owner.channel === 'slack' && owner.id === identity.id)) return { owned: false, durable: false };
  const policy = readSlackDeliveryPolicy(options), ref = parseSlackThreadRef(message.channel_ref);
  if (options.signal?.aborted || !policy || !ref || ref.teamId !== policy.config.teamId || message.origin_bridge !== policy.config.bridgeId ||
      !policy.config.map.some(route => route.channel === ref.channelId) ||
      !policy.teamIdentities.some(member => member.channel === 'slack' && member.id === identity.id)) return { owned: true, durable: false };
  // U-prefixed IDs also belong to bot users. Prove this exact configured owner
  // is a current human in the authenticated workspace before granting authority.
  try {
    const result = await (options.call ?? configuredSlackCall(policy.config, options.signal))('users.info', { user: identity.id });
    const user = result.user as Record<string, unknown> | undefined;
    if (!user || typeof user !== 'object' || Array.isArray(user) || user.id !== identity.id || user.team_id !== policy.config.teamId ||
        user.is_bot !== false || user.is_app_user === true || user.deleted === true || user.is_stranger === true ||
        user.is_restricted === true || user.is_ultra_restricted === true || options.signal?.aborted) return { owned: true, durable: false };
  } catch { return { owned: true, durable: false }; }
  const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const body = checked.value.body;
  const text = body && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string' ? body.text : undefined;
  const appendInbox = leaderInboxAppender(options);
  // A pure status ask is answered in-thread instead of becoming a P0 inbox
  // order. Only when a sole-writer appender exists: it is what writes today's
  // P0 block if the answer cannot be delivered, so nothing is ever dropped.
  const statusReply = options.statusReply, statusAsk = Boolean(statusReply && appendInbox && text !== undefined && statusReply.ask(text));
  const receivedAt = (options.now ?? Date.now)();
  const network = createLeaderNetwork({ ...sources, runsDir, busRoot: options.busRoot, now: options.now, appendInbox,
    deliver: (owner, reply) => deliverSlackLeaderMessage(owner, reply, options) });
  // For a status ask the adapter owns the inbox decision: the route is still
  // durable and bus-published (the Leader's pending queue and replay dedupe),
  // but the inbox record is deferred to the delivery-failure fallback below.
  const result = await network.ingest({ message: {
    // A namespaced 128-bit receipt avoids secret-value heuristics on raw digests.
    ...checked.value, id: `slack-owner-${createHash('sha256').update(message.id).digest('hex').slice(0, 32)}`, from: 'mason',
    sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
  }, verifiedSender: identity, receivedAt, ...(statusAsk ? { inboxAlreadyRecorded: true } : {}) });
  let statusAnswer: Promise<SlackStatusAnswer> | undefined;
  if (statusAsk && result.requestId && result.status !== 'duplicate') {
    const fallback = { requestId: result.requestId, channel: 'slack' as const, ownerId: identity.id, receivedAt,
      // Byte-identical to what the network itself would hand the sole writer.
      text: text!.replace(/\r\n?/g, '\n').trim() };
    // Detached so the socket ack is not held behind the brief read or the post.
    statusAnswer = (result.status === 'accepted'
      ? answerOwnerStatus(statusReply!, result.requestId, network, runsDir, new Date(receivedAt))
      : Promise.resolve({ answered: false, reason: 'ask did not reach the Leader bus' }))
      .then(async outcome => {
        if (outcome.answered) return outcome;
        try { await appendInbox!(fallback); } catch {
          console.warn(`[slack-leader] status ask not answered in-thread (${outcome.reason}) and the MASON-INBOX fallback failed; it stays pending for the Leader`);
          return { answered: false, reason: `${outcome.reason}; inbox fallback failed` };
        }
        console.warn(`[slack-leader] status ask not answered in-thread (${outcome.reason}); recorded it in MASON-INBOX as P0 instead`);
        return outcome;
      });
  }
  const durable = result.status === 'accepted' || result.status === 'duplicate' || result.recorded === true;
  // Same unified owner thread the other channels feed; the Slack thread ref rides along so the reply goes back to it.
  if (durable && text) await noteUnifiedOwner('slack', identity.id, text, checked.value.id, receivedAt, options, message.channel_ref);
  return { owned: true, durable, ...(statusAnswer ? { statusAnswer } : {}) };
}

/** Compose with the existing status builder and send through the journaled
 * Leader reply (MASON-OUTBOX record, bus publish, same Slack thread). */
async function answerOwnerStatus(statusReply: SlackStatusReply, requestId: string, network: ReturnType<typeof createLeaderNetwork>, runsDir: string, now: Date): Promise<SlackStatusAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([statusReply.compose(runsDir, now),
    new Promise<string>(resolve => { timer = setTimeout(() => resolve(statusReply.fallback), 10_000); })])
    .catch(() => statusReply.fallback).finally(() => clearTimeout(timer));
  try {
    const sent = await network.reply(requestId, text);
    return sent.status === 'sent' || sent.status === 'duplicate'
      ? { answered: true, reason: 'answered in-thread' }
      : { answered: false, reason: `reply ${sent.status}${sent.reason ? `: ${sent.reason}` : ''}` };
  } catch { return { answered: false, reason: 'reply threw' }; }
}

/** Same-channel/thread delivery, with the existing send-intent journal owning uncertainty. */
export async function deliverSlackLeaderMessage(identity: TeamIdentity, message: BusEnvelope, options: SlackLeaderOptions = {}): Promise<DeliverResult> {
  const sources = readLeaderNetworkConfig(options), policy = readSlackDeliveryPolicy(options);
  if (identity.channel !== 'slack' || !isSlackUserId(identity.id) ||
      !parseMasonIdentities(sources.configSource).some(owner => owner.channel === 'slack' && owner.id === identity.id) ||
      !policy || options.signal?.aborted || message.channel !== 'slack' || message.from !== 'leader' || message.to !== 'mason' ||
      message.sender?.agent_id !== 'leader' || message.sender.human !== false || message.origin_bridge !== 'leader-network') {
    return { status: 'refused', reason: 'No current verified Slack owner route.' };
  }
  const ref = parseSlackThreadRef(message.channel_ref), body = message.body;
  const route = ref && policy.config.map.find(mapping => mapping.channel === ref.channelId);
  if (!ref || ref.teamId !== policy.config.teamId || !route || !body || typeof body !== 'object' || Array.isArray(body) ||
      body.kind !== 'leader-reply' || typeof body.text !== 'string') return { status: 'refused', reason: 'Slack reply route or body is invalid.' };
  // Stay below the existing Leader delivery boundary's thirty-second limit.
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  const transport = options.call ?? configuredSlackCall(policy.config, signal);
  const call: SlackCall = (method, input, credential) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('slack-session-expired')); return; }
    const abort = (): void => reject(new Error('slack-session-expired'));
    signal.addEventListener('abort', abort, { once: true });
    void transport(method, input, credential).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  const result = await deliverSlackEnvelope({ ...message, to: route.topic,
    body: { kind: 'note', text: body.text, thread: message.channel_ref! } }, {
    ...policy, call, signal,
    stateRoot: options.runsDir ? join(options.runsDir, 'slack-transport') : undefined,
    readPolicy: () => {
      const current = readLeaderNetworkConfig(options);
      return parseMasonIdentities(current.configSource).some(owner => owner.channel === 'slack' && owner.id === identity.id)
        ? readSlackDeliveryPolicy(options) : undefined;
    },
  });
  if (result.status === 'sent' || result.status === 'duplicate') return { status: 'sent', reason: 'Slack delivery is durably proved.' };
  // The Slack journal, not the Leader journal, fences the native side effect.
  // Future Leader passes can safely perform read-only reconciliation by the same ID.
  return { status: 'drafted', reason: result.status === 'uncertain' ? 'Slack send is unconfirmed; reconciliation is pending.' : 'Slack delivery is unavailable or policy refused it.' };
}

/** The transport drains existing Leader drafts; the resident Leader owns model generation. */
export async function flushSlackLeaderReplies(options: SlackLeaderOptions = {}): Promise<{ state: 'completed' | 'unavailable'; sent: number }> {
  try {
    const sources = leaderNetworkSources(options);
    const network = createLeaderNetwork({ ...sources, runsDir: options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'),
      busRoot: options.busRoot, now: options.now, appendInbox: leaderInboxAppender(options), deliver: (identity, message) => deliverSlackLeaderMessage(identity, message, options) });
    let sent = 0;
    for (const pending of (await network.pending()).filter(row => row.envelope.channel === 'slack').slice(0, 5)) {
      if (options.signal?.aborted) break;
      if (pending.replyText && (await network.reply(pending.requestId, pending.replyText)).status === 'sent') sent++;
    }
    return { state: 'completed', sent };
  } catch { return { state: 'unavailable', sent: 0 }; }
}
