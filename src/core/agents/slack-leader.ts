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
import { composeStatusReply, isStatusRequest, readStatusFacts, type StatusFactsOptions } from './leader-status-reply.js';

export interface SlackLeaderOptions extends LeaderRuntimeOptions { call?: SlackCall; signal?: AbortSignal; statusReaders?: Pick<StatusFactsOptions, 'readInstalled' | 'readLatest'> }

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
export async function ingestSlackLeaderEnvelope(message: BusEnvelope, options: SlackLeaderOptions = {}): Promise<{ owned: boolean; durable: boolean }> {
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
  const network = createLeaderNetwork({ ...sources, runsDir: options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), busRoot: options.busRoot, now: options.now, appendInbox: leaderInboxAppender(options) });
  const result = await network.ingest({ message: {
    // A namespaced 128-bit receipt avoids secret-value heuristics on raw digests.
    ...checked.value, id: `slack-owner-${createHash('sha256').update(message.id).digest('hex').slice(0, 32)}`, from: 'mason',
    sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
  }, verifiedSender: identity, receivedAt: (options.now ?? Date.now)() });
  const durable = result.status === 'accepted' || result.status === 'duplicate' || result.recorded === true;
  // Same unified owner thread the other channels feed; the Slack thread ref rides along so the reply goes back to it.
  if (durable) {
    const body = checked.value.body;
    const text = body && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string' ? body.text : undefined;
    if (text) await noteUnifiedOwner('slack', identity.id, text, checked.value.id, (options.now ?? Date.now)(), options, message.channel_ref);
  }
  return { owned: true, durable };
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
      let text = pending.replyText;
      // A bare status question gets a factual local answer; anything else waits for the model.
      const asked = (pending.envelope.body as { text?: unknown } | undefined)?.text;
      if (!text && typeof asked === 'string' && isStatusRequest(asked)) {
        const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
        text = composeStatusReply(await readStatusFacts({ runsDir, now: options.now ? () => new Date(options.now!()) : undefined, ...options.statusReaders }));
      }
      if (text && (await network.reply(pending.requestId, text)).status === 'sent') sent++;
    }
    return { state: 'completed', sent };
  } catch { return { state: 'unavailable', sent: 0 }; }
}
