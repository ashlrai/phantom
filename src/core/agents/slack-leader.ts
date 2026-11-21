/** Trusted Socket Mode owner adapter for the existing Leader network. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realHome } from '../real-home.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { leaderInboxAppender, leaderNetworkSources, noteUnifiedOwner, readLeaderNetworkConfig, type LeaderRuntimeOptions } from './leader-network-runtime.js';
import { createLeaderNetwork, parseMasonIdentities } from './leader-network.js';
import { recordSlackObservation } from './slack-journal.js';
import { isSlackRequestId } from './slack-reply-identity.js';
import { takeLeaderReplyBatch } from './leader-reply-queue.js';
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
  /** Compose the answer for a gated ask; `text` is the owner's ask, so one
   * reply seam can answer more than one exact ask (status, recheck). */
  compose(runsDir: string, now: Date, text?: string): Promise<string>;
  /** Posted when compose throws or misses its deadline. */
  readonly fallback: string;
  /** Optional read-only evidence block appended to the long live-evidence ask's
   * recheck reply (runtime identity, claims, Dot bridge owner). A throw keeps
   * the recheck text alone. */
  evidence?(runsDir: string, now: Date): Promise<string>;
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
  // A pure status ask is answered in-thread instead of becoming a second P0
  // order in the operator's MASON-INBOX. Only the installed host's sole writer
  // owns that deferral: it is what writes today's P0 block when the answer
  // cannot be delivered, so nothing is ever dropped. An injected writer or
  // the local leader journal keeps its durable record at ingest instead.
  const statusReply = options.statusReply, statusAsk = Boolean(statusReply && text !== undefined && statusReply.ask(text));
  // A long message that asks for a live-state recheck carries other content for
  // the Leader, so it is never deferred: MASON-INBOX gets it at ingest as always,
  // and the in-thread recheck verdict is an addition to that record.
  const evidenceAsk = Boolean(statusReply) && !statusAsk && text !== undefined && isLiveEvidenceAsk(text);
  const deferInbox = statusAsk && appendInbox !== undefined && options.appendInbox === undefined;
  const receivedAt = (options.now ?? Date.now)();
  const network = createLeaderNetwork({ ...sources, runsDir, busRoot: options.busRoot, now: options.now, appendInbox,
    deliver: (owner, reply) => deliverSlackLeaderMessage(owner, reply, options) });
  const result = await network.ingest({ message: {
    // A namespaced 128-bit receipt avoids secret-value heuristics on raw digests.
    ...checked.value, id: `slack-owner-${createHash('sha256').update(message.id).digest('hex').slice(0, 32)}`, from: 'mason',
    sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
  }, verifiedSender: identity, receivedAt, ...(deferInbox ? { inboxAlreadyRecorded: true } : {}) });
  // Owner routing bypasses peer ingress; retain its receipt in the same trace.
  const messageRef = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.refs)
    && typeof body.refs[0] === 'string' ? parseSlackThreadRef(body.refs[0]) : undefined;
  if (messageRef && messageRef.teamId === ref.teamId && messageRef.channelId === ref.channelId &&
      message.id === `slack-${ref.teamId}-${ref.channelId}-${messageRef.rootTs}` && result.status !== 'duplicate') {
    recordSlackObservation({ at: new Date(receivedAt).toISOString(), decision: 'ingested',
      channelId: ref.channelId, threadTs: ref.rootTs, messageTs: messageRef.rootTs,
      bus: result.status === 'accepted' ? 'posted' : 'failed',
      // Only a positive Leader-route result carries a reply identity: the ingest
      // either returned the Leader-addressed envelope or recorded it in the
      // Leader inbox. An agent-addressed owner request gets no Leader reply.
      ...(isSlackRequestId(result.requestId) && (result.envelope?.to === 'leader' || result.recorded === true)
        ? { requestId: result.requestId } : {}) }, { runsDir });
  }
  let statusAnswer: Promise<SlackStatusAnswer> | undefined;
  if ((statusAsk || evidenceAsk) && result.requestId && result.status !== 'duplicate') {
    // Detached so the socket ack is not held behind the brief read or the post;
    // the reply goes through the same journaled route and never alters ingest.
    const fallback = deferInbox ? {
      requestId: result.requestId, channel: 'slack' as const, ownerId: identity.id, receivedAt,
      // Byte-identical to what the network itself would hand the sole writer.
      text: text!.replace(/\r\n?/g, '\n').trim(),
    } : undefined;
    statusAnswer = (result.status === 'accepted'
      ? answerOwnerStatus(evidenceAsk ? recheckOnly(statusReply!) : statusReply!, result.requestId, network, runsDir, new Date(receivedAt), text!)
      : Promise.resolve({ answered: false, reason: 'ask did not reach the Leader bus' }))
      .then(async outcome => {
        if (outcome.answered || !fallback) return outcome;
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

/** Signal groups for a long owner message that asks Phantom to recheck live
 * state, e.g. "recheck the current runtime ... return runtime identity, a fresh
 * shared context/claims read and the owner of the Dot bridge". */
export const LIVE_EVIDENCE_SIGNALS: readonly RegExp[] = [
  /\bre-?(?:check|verify)\b[^.\n]{0,40}\b(?:runtime|live state)\b/,
  /\bruntime identity\b/,
  /\bfresh\b[^.\n]{0,30}\bclaims?\b[^.\n]{0,20}\bread\b/,
  /\bowner of (?:the |a )?(?:\w+ )?bridge\b|\bbridge owner\b/,
  /\b(?:cannot|can't|can not|unable to) reach live state\b|\bmissing bridge\b/,
];

/** True for a message of at most 4000 chars matching at least two distinct
 * signal groups. Short exact asks ("recheck", "status") are matched earlier by
 * the injected `statusReply.ask`, so they never reach this. Pure. */
export function isLiveEvidenceAsk(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '' || text.length > 4000) return false;
  const folded = text.toLowerCase().replace(/[’‘]/g, "'");
  return LIVE_EVIDENCE_SIGNALS.filter(signal => signal.test(folded)).length >= 2;
}

/** Answers a long evidence ask with the exact recheck reply a short "recheck"
 * gets (the injected composer never falls through to the digest), headed by a
 * line saying the full message was also recorded. Never fabricates state. */
function recheckOnly(statusReply: SlackStatusReply): SlackStatusReply {
  const { evidence } = statusReply;
  return { ask: statusReply.ask, fallback: statusReply.fallback,
    compose: async (runsDir, now) => {
      const recheck = `Phantom recheck (full message recorded for the Leader):\n${await statusReply.compose(runsDir, now, 'recheck')}`;
      if (!evidence) return recheck;
      try { return `${recheck}\n\n${await evidence.call(statusReply, runsDir, now)}`; } catch { return recheck; }
    } };
}

/** Compose with the existing status builder and send through the journaled
 * Leader reply (MASON-OUTBOX record, bus publish, same Slack thread). */
async function answerOwnerStatus(statusReply: SlackStatusReply, requestId: string, network: ReturnType<typeof createLeaderNetwork>, runsDir: string, now: Date, ask: string): Promise<SlackStatusAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race([statusReply.compose(runsDir, now, ask),
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
    ...policy, call, signal, runsDir: options.runsDir, busRoot: options.busRoot, leaderRequestId: typeof body.requestId === 'string' ? body.requestId : undefined,
    plainReply: options.statusReply !== undefined && body.text === `Leader: ${options.statusReply.fallback}`,
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
    const directory = join(options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'leader');
    const batch = takeLeaderReplyBatch((await network.pending()).filter(row => row.envelope.channel === 'slack' && row.replyText), directory, 'slack-reply-cursor.json');
    for (const pending of batch) {
      if (options.signal?.aborted) break;
      if (pending.replyText && (await network.reply(pending.requestId, pending.replyText)).status === 'sent') sent++;
    }
    return { state: 'completed', sent };
  } catch { return { state: 'unavailable', sent: 0 }; }
}
