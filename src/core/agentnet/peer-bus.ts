/** Authenticated peer coordination on the existing bus; messages grant no execution authority. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { workPostBodySchema, workStatusBodySchema } from '../agents/bus-v2-schema.js';
import { busBodyJobMatch, busReadContains, busReadContainsMatch } from '../agents/bus-unified.js';
import { readBusWorkFeed, runtimeProvider } from '../agents/bus-work-feed-read.js';
import { readAgentRegistry, resolveAgent } from '../agents/bus-identity.js';
import { localWriteGate } from '../agents/send-gate.js';
import { configuredSlackCall, readSlackDeliveryPolicy } from '../agents/slack-leader.js';
import { evaluateSlackAudience } from '../agents/slack-audience.js';
import { deliverSlackEnvelope, observeSlackAudience, type SlackCall } from '../agents/slack-transport.js';
import { parseSlackThreadRef } from '../agents/slack-network.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { BUS_PRIORITIES, type BusPriority } from '../fleet/bus-envelope.js';
import { appendNeedsMasonLine } from '../fleet/needs-mason-append.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { agentnetPaths, authenticatePeer, callsignSchema, readPeerBindings, readPeerJson, type PeerSession } from './slack-identities.js';
import { readWorkDispatchJournal, workDispatchResultBody, type WorkDispatchReceipt } from './work-dispatch-journal.js';

export const PEER_MAX_HOPS = 8, PEER_PAIR_LIMIT = 6, PEER_WINDOW_MS = 60_000;
const idSchema = z.string().regex(/^peer-[a-f0-9-]{36}(?![\s\S])/);
const reference = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:/#-]+(?![\s\S])/).refine(v => scrubSecrets(v) === v);
export const peerRequestSchema = z.object({
  toAgent: callsignSchema.optional(), channel: z.string().regex(/^[CG][A-Z0-9]{2,32}(?![\s\S])/).optional(),
  kind: z.enum(['task', 'review', 'handoff', 'query', 'social']), text: z.string().trim().min(1).max(12_000),
  refs: z.array(reference).max(32).default([]), threadId: reference.optional(), replyTo: idSchema.optional(),
  work: z.discriminatedUnion('kind', [workPostBodySchema, workStatusBodySchema]).optional(),
}).strict().refine(r => Boolean(r.toAgent) !== Boolean(r.channel))
  .refine(r => !r.work || (r.kind === 'task' && Boolean(r.toAgent) && scrubSecrets(JSON.stringify(r.work)) === JSON.stringify(r.work)));
export type PeerRequest = z.input<typeof peerRequestSchema>;
export const rowSchema = z.object({ id: idSchema, fromAgent: callsignSchema, target: reference, origin: idSchema,
  digest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/), hopCount: z.number().int().min(1).max(8), threadId: reference, at: z.number().int().nonnegative() }).strict();
type Row = z.infer<typeof rowSchema>;
export type { Row as PeerLedgerRow };
export interface PeerBusOptions {
  bindings?: string; busRoot?: string; runsDir?: string; now?: () => number;
  /** Trusted host broker seams; never selected by a message or a CLI flag. */
  call?: SlackCall; readPolicy?: typeof readSlackDeliveryPolicy;
}
export interface PeerResult { status: string; reason?: string; id?: string; origin?: string; hopCount?: number; slack?: string }

/**
 * The shared bus read-filter grammar `peers read` applies to admitted peer
 * envelopes — the same rules `agents bus inbox`, `agents bus channel read`,
 * `comms bus read` and `fleet bus-follow` share, minus the sender/thread
 * filters a callsign cannot express. Every field narrows the admitted page;
 * none widens it, and an envelope that cannot prove the predicate stays out
 * of the match rather than being counted as a hit.
 */
export interface PeerInboxFilter {
  /**
   * Time filter: only messages received at or after this epoch-ms cutoff —
   * the same inclusive `receivedAt >= since` match `agents bus inbox
   * --since` applies.
   */
  since?: number;
  /**
   * Exclusive time ceiling: only messages received strictly before this
   * epoch-ms cutoff — the same `< before` upper bound every bus read
   * `--before` applies, composing with `since` into one `[since, before)`
   * window. A message exactly on the cutoff stays out.
   */
  before?: number;
  /**
   * Text filter: only messages whose scrubbed one-line summary — the same
   * text the bus inbox frame renders per row — carries the needle as a
   * case-insensitive substring, the same `busReadContainsMatch` rule
   * `inbox --contains` applies. Matching runs over the rendered summary,
   * never the raw body, so a secret-shaped value stays unfindable.
   */
  contains?: string;
  /**
   * Priority filter: only envelopes stamped with this exact P0..P3 band —
   * the same match `comms bus read --priority` applies.
   */
  priority?: BusPriority;
  /**
   * Job filter: only messages that name this one job — the same
   * `busBodyJobMatch` rule `agents bus inbox --job` applies: a feed-citing
   * body (`work.post`, `work.status`, `work.result` or `wake`) declaring
   * that `jobId`, a `worker-handoff` assigning that fleet job id through
   * `taskId`, or a `note`/`context` body carrying the `job:<id>` v2 thread
   * label. A `peer.message` body cites no job and never matches.
   */
  job?: string;
}

type ParsedPeerInboxFilter = { ok: true; since?: number; before?: number; containsNeedle?: string;
  priority?: BusPriority; job?: string } | { ok: false; reason: string };

/** Validate the peer read filter set before the bus store is scanned. */
function parsePeerInboxFilter(filter: PeerInboxFilter): ParsedPeerInboxFilter {
  const { since, before, contains, priority, job } = filter;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { ok: false, reason: 'Invalid since.' };
  }
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    return { ok: false, reason: 'Invalid before.' };
  }
  if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) {
    return { ok: false, reason: 'Invalid priority.' };
  }
  if (job !== undefined && (typeof job !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(job))) {
    return { ok: false, reason: 'Invalid job id.' };
  }
  const containsNeedle = busReadContains(contains);
  if (containsNeedle === null) return { ok: false, reason: 'Invalid contains filter.' };
  return { ok: true,
    ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }),
    ...(priority === undefined ? {} : { priority }), ...(job === undefined ? {} : { job }),
    ...(containsNeedle === undefined ? {} : { containsNeedle }) };
}

/** The owner rule the shared work-feed projection applies: the job owner's own
 * label, or any label resolving to the same registered identity. An unreadable
 * registry resolves nothing, so only exact label equality can pass — the same
 * answer the feed gives, which means an admitted status can never poison the
 * projection for every reader. */
function peerOwnsFeedJob(owner: string, callsign: string, busRoot: string): boolean {
  if (owner === callsign) return true;
  const registry = readAgentRegistry({ root: busRoot });
  if (registry.status !== 'ok') return false;
  const ownerId = resolveAgent(registry.registry, owner)?.id;
  return ownerId !== undefined && ownerId === resolveAgent(registry.registry, callsign)?.id;
}

export async function sendPeerMessage(input: unknown, session: PeerSession, options: PeerBusOptions = {}): Promise<PeerResult> {
  const parsed = peerRequestSchema.safeParse(input);
  if (!parsed.success) return { status: 'refused', reason: 'invalid-peer-message' };
  const blocked = localWriteGate();
  if (blocked) return blocked;
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome>['lock'] = null;
  try {
    const paths = { ...agentnetPaths(), ...options }, now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) return { status: 'refused', reason: 'invalid-clock' };
    const peers = readPeerBindings(paths.bindings), sender = authenticatePeer(peers, session, now), request = parsed.data;
    const recipient = request.toAgent ? peers.find(p => p.callsign === request.toAgent && p.expiresAt > now) : undefined;
    if (request.toAgent && (!recipient || recipient.teamId !== sender.teamId || recipient.callsign === sender.callsign)) return { status: 'refused', reason: 'unknown-peer' };
    // A work.post joins the shared feed projection, which refuses its whole
    // read on an unattributable provider or a duplicate job id — the same
    // poison announceWork guards against. A work.status moves a job the feed
    // already shows, and the projection refuses its whole read on a foreign
    // owner's status. Verify both against the live feed first.
    const work = request.work;
    if (work !== undefined) {
      if (work.kind === 'work.post' && work.provider === undefined) {
        const registry = readAgentRegistry({ root: paths.busRoot });
        const identity = registry.status === 'ok' ? resolveAgent(registry.registry, sender.callsign) : undefined;
        if (identity === undefined || runtimeProvider(identity) === undefined) {
          return { status: 'refused', reason: 'work-provider-required' };
        }
      }
      const feed = readBusWorkFeed({ root: paths.busRoot, now: () => now });
      if (feed.status !== 'ok') return { status: 'refused', reason: `work-feed-${feed.status}` };
      if (work.kind === 'work.post') {
        if (feed.jobs.some(job => job.id === work.jobId)) return { status: 'refused', reason: 'work-job-exists' };
      } else {
        const job = feed.jobs.find(candidate => candidate.id === work.jobId);
        if (job === undefined) return { status: 'refused', reason: 'work-job-unknown' };
        if (!peerOwnsFeedJob(job.owner, sender.callsign, paths.busRoot)) {
          return { status: 'refused', reason: 'work-status-not-owner' };
        }
      }
    }
    const policyReader = options.readPolicy ?? (() => {
      const base = readSlackDeliveryPolicy();
      return base && { ...base, config: { ...base.config, ownUserId: sender.userId, ownBotId: sender.botId } };
    }), policy = policyReader();
    if (!policy || policy.config.teamId !== sender.teamId || policy.config.ownUserId !== sender.userId || policy.config.ownBotId !== sender.botId) return { status: 'refused', reason: 'bot-binding-mismatch' };
    const mapping = policy.config.map.find(m => request.channel ? m.channel === request.channel : m.topic === recipient?.topic);
    if (!mapping || !/^[CG]/.test(mapping.channel)) return { status: 'refused', reason: 'unmapped-team-channel' };
    const signal = AbortSignal.timeout(30_000), rawCall = options.call ?? configuredSlackCall(policy.config, signal);
    // Apply the mesh's stricter channel rule again when the broker refreshes its audience.
    const call: SlackCall = async (method, args, credential) => {
      const result = await rawCall(method, args, credential);
      if (method === 'conversations.info') {
        const c = result.channel as Record<string, unknown> | undefined;
        if (!c || (c.is_channel !== true && c.is_group !== true) || c.is_im === true || c.is_mpim === true ||
            c.is_shared !== false || c.is_ext_shared !== false || c.is_pending_ext_shared !== false) throw new Error('peer-channel-unproved');
      }
      return result;
    };
    const audience = await observeSlackAudience(call, mapping.channel);
    if (audience.complete !== true ||
        evaluateSlackAudience(policy.config, policy.teamIdentities, mapping.channel, audience).status !== 'postable' ||
        !audience.members.some(m => m.id === sender.userId) || (recipient && !audience.members.some(m => m.id === recipient.userId))) return { status: 'refused', reason: 'team-audience-unproved' };
    const currentSender = authenticatePeer(readPeerBindings(paths.bindings), session, (options.now ?? Date.now)());
    if (JSON.stringify(sender) !== JSON.stringify(currentSender) || localWriteGate()) return { status: 'refused', reason: 'peer-policy-changed' };
    const directory = join(paths.busRoot, 'agentnet'), file = join(directory, 'coordination.json');
    ensurePrivateDirectory(directory);
    const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'writer.lock'), 0, { anchorPath: paths.busRoot, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') return { status: 'refused', reason: 'peer-store-busy' };
    lock = acquired.lock;
    const rows = existsSync(file) ? z.array(rowSchema).max(1024).parse(readPeerJson(file, paths.busRoot)) : [];
    if (rows.some(r => r.at > now)) return { status: 'refused', reason: 'peer-clock-reversed' };
    const live = rows.filter(r => now - r.at < 86_400_000), target = request.toAgent ?? mapping.channel;
    const parent = request.replyTo ? live.find(r => r.id === request.replyTo) : undefined;
    if (!parent && request.threadId && live.some(r => r.threadId === request.threadId)) return { status: 'refused', reason: 'reply-parent-required' };
    if (request.replyTo && (!parent || (parent.target !== sender.callsign && parent.target !== mapping.channel))) return { status: 'refused', reason: 'invalid-parent' };
    const id = `peer-${randomUUID()}`, origin = parent?.origin ?? id, hopCount = (parent?.hopCount ?? 0) + 1;
    if (hopCount > PEER_MAX_HOPS || live.some(r => r.origin === origin && r.fromAgent === sender.callsign && r.target === target)) {
      const result = appendBusInbox({ id: `peer-escalation-${origin}`, from: 'agentnet', to: 'leaders', priority: 'P1', ttl: 86_400_000,
        body: { kind: 'peer.escalation', origin, reason: 'loop-or-hop-cap' } }, { root: paths.busRoot });
      if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('peer-escalation-unavailable');
      if (result.status === 'posted') appendNeedsMasonLine(paths.runsDir, `Agentnet loop/hop cap: ${origin}; inspect the agent bus.`);
      return { status: 'escalated', reason: 'loop-or-hop-cap', origin };
    }
    // Channel sends debit every currently eligible recipient pair as well as the channel.
    const eligible = recipient ? [] : peers.filter(p => p.callsign !== sender.callsign &&
      p.expiresAt > now && p.teamId === sender.teamId && audience.members.some(m => m.id === p.userId));
    const targets = recipient ? [recipient.callsign] : [target, ...eligible.map(p => p.callsign)];
    if (targets.some(t => live.filter(r => r.fromAgent === sender.callsign && r.target === t && now - r.at < PEER_WINDOW_MS).length >= PEER_PAIR_LIMIT)) return { status: 'refused', reason: 'pair-rate-limit' };
    if (live.length + targets.length > 1024) return { status: 'refused', reason: 'peer-store-full' };
    const threadId = parent?.threadId ?? request.threadId ?? origin;
    if (parent && request.threadId && request.threadId !== parent.threadId) return { status: 'refused', reason: 'thread-mismatch' };
    const slackThread = parseSlackThreadRef(threadId);
    if (threadId.startsWith('slack:') && (!slackThread || slackThread.teamId !== sender.teamId || slackThread.channelId !== mapping.channel)) return { status: 'refused', reason: 'foreign-thread' };
    const message = { fromAgent: sender.callsign, ...(recipient ? { toAgent: recipient.callsign } : { channel: mapping.channel }),
      kind: request.kind, text: scrubSecrets(request.text), refs: request.refs, threadId, origin, hopCount };
    const envelope = { id, from: sender.callsign, to: recipient?.callsign ?? mapping.topic, priority: 'P2' as const,
      ttl: 86_400_000, body: request.work ?? { kind: 'peer.message', peer: message } };
    const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    const row: Row = { id, fromAgent: sender.callsign, target, origin, hopCount, threadId, at: now, digest };
    // Reserve before publication. A crash may consume capacity, never allow a duplicate send.
    writePrivateFileAtomic(file, JSON.stringify([...live, ...targets.map(t => ({ ...row, target: t }))]));
    const posted = appendBusInbox(envelope, { root: paths.busRoot, now: () => now });
    if (posted.status !== 'posted') return { status: 'refused', reason: 'peer-bus-unavailable' };
    releaseLocalStoreLock(lock); lock = null;
    // The generic Slack drain refuses peer.message. Only this bound broker may adapt it.
    if (!policy.confirmedByMason) return { status: 'drafted', id, origin, hopCount, slack: 'approval-required' };
    const delivery = await deliverSlackEnvelope({ ...envelope, to: mapping.topic,
      body: { kind: 'note', text: JSON.stringify(request.work ?? message), thread: threadId } }, { ...policy, call, signal,
      stateRoot: join(directory, 'slack'), readPolicy: () => {
        try {
          const latestPolicy = policyReader();
          const bindings = readPeerBindings(paths.bindings), at = (options.now ?? Date.now)();
          const fresh = authenticatePeer(bindings, session, at);
          // A debited binding revoked, replaced or expired mid-flight cancels the post; the audience is never narrowed.
          for (const bound of recipient ? [recipient] : eligible) {
            if (!bindings.some(p => JSON.stringify(p) === JSON.stringify(bound) && p.expiresAt > at)) return undefined;
          }
          if (JSON.stringify(fresh) !== JSON.stringify(sender) || localWriteGate()) return undefined;
          return latestPolicy;
        } catch { return undefined; }
      } });
    return { status: 'posted', id, origin, hopCount, slack: delivery.status };
  } catch { return { status: 'refused', reason: 'peer-state-or-transport-unavailable' }; }
  finally { releaseLocalStoreLock(lock); }
}

const WORK_RESULT_ID = /^(pw-[a-f0-9]{32})-(reserved|admitted|complete|failed)$/;
/** work.result replies bypass the admission ledger; only the private dispatch
 * journal proves this host published that outcome to this callsign, with the
 * exact body it wrote. Only the latest sent outcome per receipt is admitted;
 * earlier per-outcome replies stay bus-local history. */
function admittedWorkResult(original: NonNullable<BusInboxReceipt['originalEnvelope']>,
  callsign: string, receipts: ReadonlyMap<string, WorkDispatchReceipt>): boolean {
  if (original.to !== callsign) return false;
  const match = WORK_RESULT_ID.exec(original.id);
  if (!match) return false;
  const receipt = receipts.get(match[1]!);
  if (!receipt || receipt.peer !== callsign || receipt.sent !== match[2] ||
      receipt.outcome !== match[2] || original.from !== receipt.consumer) return false;
  return JSON.stringify(original.body) === JSON.stringify(workDispatchResultBody(receipt));
}

/** Raw bus labels are never identities. Only matching private admission receipts are peers.
 * `filter` narrows the admitted page with the shared bus read grammar; it never
 * widens admission and the `after`/`nextCursor` paging contract is unchanged —
 * a filtered page may be sparse while `nextCursor` still resumes past every
 * scanned row, so callers keep paging exactly as an unfiltered read does. */
export function readPeerInbox(session: PeerSession, after = 0, options: PeerBusOptions = {}, filter: PeerInboxFilter = {}) {
  const paths = { ...agentnetPaths(), ...options }, now = (options.now ?? Date.now)();
  const parsed = parsePeerInboxFilter(filter);
  const peer = authenticatePeer(readPeerBindings(paths.bindings), session, now);
  const file = join(paths.busRoot, 'agentnet', 'coordination.json');
  const rows = existsSync(file) ? z.array(rowSchema).max(1024).parse(readPeerJson(file, paths.busRoot)) : [];
  const journal = readWorkDispatchJournal(paths.busRoot);
  if (!parsed.ok) return { status: 'invalid' as const, reason: parsed.reason, workResults: journal.status };
  const dispatched = new Map(journal.receipts.map(receipt => [receipt.receiptId, receipt]));
  const page = listBusInboxAfter(after, 100, { root: paths.busRoot, now: () => now, includeOriginalEnvelope: true });
  if (page.status !== 'ok') return { ...page, workResults: journal.status };
  const { since, before, containsNeedle, priority, job } = parsed;
  const messages = page.messages.filter(receipt => {
    const original = receipt.originalEnvelope;
    return original !== undefined && (rows.some(row => row.id === original.id &&
      row.target === peer.callsign && row.at <= now && now - row.at < 86_400_000 &&
      receipt.receivedAt === row.at &&
      row.digest === createHash('sha256').update(JSON.stringify(original)).digest('hex')) ||
      admittedWorkResult(original, peer.callsign, dispatched)) &&
      (since === undefined || receipt.receivedAt >= since) &&
      (before === undefined || receipt.receivedAt < before) &&
      (priority === undefined || original.priority === priority) &&
      (job === undefined || busBodyJobMatch(original.body, job)) &&
      (containsNeedle === undefined || busReadContainsMatch(original.body, containsNeedle));
  }).map(({ cursor, receivedAt, envelope }) => ({ cursor, receivedAt, envelope }));
  return { ...page, messages, workResults: journal.status };
}
