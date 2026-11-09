/** Leader's authenticated network boundary. Wire sender fields never prove identity. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { checkSendPolicy, parseCommsConfirmation, parseTeamIdentities, shouldIngestFromBridge, type ChannelAdapter, type ChannelId, type DeliverResult, type TeamIdentity } from './channel-policy.js';
import { localChannelAdapters } from './channel-registry.js';
import { validateBusEnvelope, type BusEnvelope } from '../fleet/bus-envelope.js';
import { appendBusInbox } from '../fleet/bus-inbox.js';
import { CHANNEL_BUS_TTL_MS } from '../fleet/channel-bus-publish.js';
import { escapeInboxContinuation, formatInboxEntry, INBOX_MAX_CHARS } from '../fleet/mason-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { scrubSecrets } from '../util/scrub.js';
import { validLeaderInboxReceipt, type LeaderInboxAppender, type LeaderInboxRequest } from './leader-inbox-writer.js';

export const LEADER_BRIDGE_ID = 'leader-network';
export const LEADER_AWAY_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_RECEIPTS = 10_000;
// Match the existing Leader reply batch; slow helpers cannot monopolize all receipts.
const INBOX_RECOVERY_BATCH = 5;
// Match the existing Mail transport's bounded send window; an acknowledgement
// timeout must not classify an ordinary multi-second channel send as interrupted.
const DELIVERY_TIMEOUT_MS = 30_000;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Same strict identity syntax as [team]; malformed [mason] means no owner. */
export function parseMasonIdentities(source: string): TeamIdentity[] {
  try {
    const doc = parse(source, { unsafeKeyBehaviour: 'throw' });
    if (!doc.mason || typeof doc.mason !== 'object' || Array.isArray(doc.mason) || Object.keys(doc.mason).some(key => key !== 'identities')) return [];
    return parseTeamIdentities(stringify({ team: doc.mason }));
  } catch { return []; }
}
function owner(identity: TeamIdentity, source: string): boolean {
  return parseMasonIdentities(source).some(value => value.channel === identity.channel && value.id === identity.id);
}

/** Explicit addressing is adapter-owned metadata, never inferred from message content. */
export function routeLeaderMessage(message: BusEnvelope, verifiedSender: TeamIdentity, configSource: string, addressedAgent?: string): BusEnvelope | null {
  const checked = validateBusEnvelope(message);
  if (!checked.ok || scrubSecrets(checked.json) !== checked.json || !owner(verifiedSender, configSource) || checked.value.external !== false || checked.value.channel !== verifiedSender.channel || !shouldIngestFromBridge(checked.value, LEADER_BRIDGE_ID)) return null;
  const to = addressedAgent ?? (['all', 'leaders', 'leader', 'default'].includes(checked.value.to) ? 'leader' : checked.value.to);
  const routed = { ...checked.value, to, priority: to === 'leader' ? 'P0' as const : checked.value.priority };
  return validateBusEnvelope(routed).ok ? routed : null;
}

interface Route { channel: ChannelId; recipient: string; channelRef: string; receivedAt: number; inbox: boolean; bus: boolean; fingerprint: string; message: BusEnvelope; reply?: { text: string; fingerprint: string; at: number; recorded: boolean; published: boolean; delivered: boolean; attempted: boolean } }
interface NetworkState { version: 1; inboxRetryCursor?: number; startedAt: number; lastMasonAt: number | null; routes: Record<string, Route>; digests: Record<string, { at: number; sent: boolean; attempted: boolean; envelope: BusEnvelope }> }
export interface LeaderNetworkOptions {
  runsDir: string;
  busRoot?: string;
  configSource: string;
  commsSource: string;
  /** Trusted runtime reader only; never serialized or selected by an envelope. */
  readCurrentPolicy?: () => { configSource: string; commsSource: string };
  deliver?: (identity: TeamIdentity, message: BusEnvelope) => Promise<DeliverResult>;
  adapters?: Partial<Record<ChannelId, ChannelAdapter>>;
  /** Trusted host dependency, never supplied by an envelope or model. */
  appendInbox?: LeaderInboxAppender;
  now?: () => number;
}
export interface LeaderNetworkInput { message: BusEnvelope; verifiedSender: TeamIdentity; addressedAgent?: string; /** Original adapter receipt clock, never a message-body claim. */ receivedAt?: number; /** Trusted adapter already wrote the durable inbox. */ inboxAlreadyRecorded?: boolean }
export interface LeaderNetworkResult { status: 'accepted' | 'duplicate' | 'ignored' | 'sent' | 'drafted' | 'refused' | 'unavailable'; reason?: string; requestId?: string; envelope?: BusEnvelope; recorded?: true }

/** Private receipts serialize writers and survive restarts. Pending inputs/replies stay private for recovery. */
export function createLeaderNetwork(options: LeaderNetworkOptions) {
  const adapters = { ...localChannelAdapters({ root: options.busRoot, now: options.now }), ...options.adapters };
  const leaderDir = join(options.runsDir, 'leader');
  const stateFile = join(leaderDir, 'network-state.json');
  const clock = options.now ?? Date.now;
  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid network clock');
    return value;
  }
  function read(file: string, maxBytes: number): string | null {
    try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const result = readStableRegularFile(file, { anchorPath: leaderDir, maxFileBytes: maxBytes, remainingBytes: maxBytes });
    if (!result.ok) throw new Error('Leader record unavailable');
    return result.text;
  }
  function saveFile(file: string, text: string): void {
    writePrivateFileAtomically(join(leaderDir, `.${randomUUID()}.tmp`), file, text, { anchorPath: leaderDir, label: 'Leader network' });
  }
  function save(state: NetworkState): void {
    const text = JSON.stringify(state);
    if (Object.keys(state.routes).length > MAX_RECEIPTS || Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('Leader receipts full');
    saveFile(stateFile, text);
  }
  async function transaction<T>(work: (state: NetworkState, at: number) => Promise<T>): Promise<T> {
    ensurePrivateDirectory(options.runsDir);
    ensurePrivateDirectory(leaderDir);
    const acquired = acquireLocalStoreLockWithOutcome(join(leaderDir, 'network.lock'), 0, { anchorPath: leaderDir });
    if (acquired.state !== 'acquired') throw new Error('Leader network busy');
    try {
      const at = now();
      const raw = read(stateFile, MAX_RECORD_BYTES);
      const state: NetworkState = raw === null ? { version: 1, startedAt: at, lastMasonAt: null, routes: {}, digests: {} } : JSON.parse(raw) as NetworkState;
      if (state.version !== 1 || !Number.isSafeInteger(state.startedAt) || state.startedAt < 0 || state.startedAt > at || (state.lastMasonAt !== null && (!Number.isSafeInteger(state.lastMasonAt) || state.lastMasonAt < 0 || state.lastMasonAt > at)) || !state.routes || typeof state.routes !== 'object' || Array.isArray(state.routes) || !state.digests || typeof state.digests !== 'object' || Array.isArray(state.digests)) throw new Error('Invalid leader state');
      if (Object.keys(state.routes).length > MAX_RECEIPTS) throw new Error('Leader receipts full');
      if (state.inboxRetryCursor !== undefined && (!Number.isSafeInteger(state.inboxRetryCursor) || state.inboxRetryCursor < 0 || state.inboxRetryCursor >= MAX_RECEIPTS)) throw new Error('Invalid inbox recovery cursor');
      for (const [key, route] of Object.entries(state.routes)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !route || typeof route !== 'object' ||
            typeof route.recipient !== 'string' || typeof route.channelRef !== 'string' ||
            typeof route.inbox !== 'boolean' || typeof route.bus !== 'boolean' ||
            !Number.isSafeInteger(route.receivedAt) || route.receivedAt < 0 || route.receivedAt > at ||
            !/^[a-f0-9]{64}$/.test(route.fingerprint) || !validateBusEnvelope(route.message).ok ||
            route.message.channel !== route.channel || route.message.channel_ref !== route.channelRef ||
            hash([route.message, route.recipient]) !== route.fingerprint || key !== hash([route.message.channel, route.message.id]) || route.recipient.length > 256 || !route.recipient.length ||
            (route.reply && (typeof route.reply.text !== 'string' || hash(route.reply.text) !== route.reply.fingerprint || !/^[a-f0-9]{64}$/.test(route.reply.fingerprint) || !Number.isSafeInteger(route.reply.at) ||
              route.reply.at < 0 || route.reply.at > at || ['recorded', 'published', 'delivered', 'attempted'].some(field => typeof route.reply?.[field as 'recorded'] !== 'boolean')))) throw new Error('Invalid leader route');
      }
      if (Object.values(state.digests).some(value => !value || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > at || typeof value.sent !== 'boolean' || typeof value.attempted !== 'boolean' || !validateBusEnvelope(value.envelope).ok)) throw new Error('Invalid digest receipts');
      // Preserve unanswered and ambiguous sends; completed history is bounded for month-long operation.
      for (const [key, route] of Object.entries(state.routes)) {
        if (at - route.receivedAt > 7 * DAY_MS && (route.reply?.delivered || route.message.to !== 'leader' && route.bus)) delete state.routes[key];
      }
      const result = await work(state, at);
      save(state);
      return result;
    } finally { releaseLocalStoreLock(acquired.lock); }
  }
  function appendRecord(file: string, id: string, content: string): void {
    const previous = read(file, MAX_RECORD_BYTES) ?? '';
    // Only generated first lines can carry this marker; continuation lines are escaped.
    if (previous.split('\n').some(line => line.startsWith('## ') && line.endsWith(`[leader-network:${id}]`))) return;
    const next = `${previous}\n${content}\n`;
    if (Buffer.byteLength(next) > MAX_RECORD_BYTES) throw new Error('Leader record full');
    // Other producers use appendFile, so never replace the shared Markdown file.
    // Validate the opened inode and append one bounded record using O_APPEND.
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = fstatSync(fd), installed = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== installed.ino || stat.dev !== installed.dev ||
          typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
          (stat.mode & 0o022) !== 0 || !assurePrivateStoragePath(file, 'file', 'inspect-existing', { anchorPath: leaderDir }).ok) throw new Error('Unsafe leader record');
      const bytes = Buffer.from(`\n${content}\n`, 'utf8');
      const written = writeSync(fd, bytes);
      if (written !== bytes.length) throw new Error('Incomplete leader record');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  function cleanText(text: string): string | null {
    if (typeof text !== 'string' || !text.trim() || text.length > INBOX_MAX_CHARS || scrubSecrets(text) !== text) return null;
    return text.replace(/\r\n?/g, '\n').trim();
  }
  function currentPolicy(): { configSource: string; commsSource: string } | null {
    try {
      const value = options.readCurrentPolicy ? options.readCurrentPolicy() : { configSource: options.configSource, commsSource: options.commsSource };
      return value && typeof value.configSource === 'string' && typeof value.commsSource === 'string' ? value : null;
    } catch { return null; }
  }
  function currentOwner(route: Pick<Route, 'channel' | 'recipient'>, policy = currentPolicy()): boolean {
    return policy !== null && owner({ channel: route.channel, id: route.recipient }, policy.configSource);
  }
  function inputText(envelope: BusEnvelope): string | null {
    const body = envelope.body;
    return cleanText(typeof body === 'string' ? body : body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string' ? body.text : '');
  }
  async function appendInbox(requestId: string, route: Route, text: string): Promise<void> {
    // Preserve the planner/ack consumers' existing wall-clock ET heading.
    const heading = formatInboxEntry('', route.channel, new Date(route.receivedAt)).trim().replace(/\([^,]+, /, '(Operator, ');
    if (route.channel === 'slack' && options.appendInbox) {
      const request: LeaderInboxRequest = { requestId, channel: 'slack', ownerId: route.recipient, receivedAt: route.receivedAt, text };
      const receipt = await options.appendInbox(request);
      if (!validLeaderInboxReceipt(receipt, request)) throw new Error('Leader inbox receipt is invalid');
    } else {
      appendRecord(join(leaderDir, 'MASON-INBOX.md'), requestId, `${heading} [leader-network:${requestId}]\n${text.split('\n').map(escapeInboxContinuation).join('\n')}`);
    }
  }
  function publish(envelope: BusEnvelope, receivedAt?: number): boolean {
    // Preserve original transport age instead of restarting TTL at this bridge.
    const post = appendBusInbox(envelope, { root: options.busRoot, now: receivedAt === undefined ? clock : () => receivedAt });
    return post.status === 'posted' || post.status === 'duplicate';
  }
  function policy(route: Pick<Route, 'channel' | 'recipient'>): DeliverResult {
    return checkSendPolicy({ channel: route.channel, recipients: [route.recipient], external: false, teamIdentities: parseTeamIdentities(options.configSource), confirmedByMason: parseCommsConfirmation(options.commsSource) });
  }
  async function deliver(route: Pick<Route, 'channel' | 'recipient'>, envelope: BusEnvelope): Promise<DeliverResult & { ambiguous?: boolean }> {
    const decision = policy(route);
    if (decision.status !== 'sent') return decision;
    if (!owner({ channel: route.channel, id: route.recipient }, options.configSource)) return { status: 'refused', reason: 'Recipient is no longer the verified owner.' };
    const adapter = adapters[route.channel];
    if (!options.deliver && (!adapter || adapter.id !== route.channel)) return { status: 'drafted', reason: 'No channel adapter is available.' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.deliver ? options.deliver({ channel: route.channel, id: route.recipient }, envelope) : adapter!.deliver(envelope),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery timeout')), DELIVERY_TIMEOUT_MS); }),
      ]);
    } catch { return { status: 'drafted', reason: 'Delivery outcome unknown; reconcile before retry.', ambiguous: true }; }
    finally { if (timer) clearTimeout(timer); }
  }
  function replyEnvelope(id: string, route: Pick<Route, 'channel' | 'channelRef'>, text: string): BusEnvelope {
    return { id: `leader-reply-${id.slice(0, 32)}`, from: 'leader', to: 'mason', priority: 'P0', ttl: CHANNEL_BUS_TTL_MS, body: { kind: 'leader-reply', requestId: id, text: `Leader: ${text}` }, channel: route.channel, channel_ref: route.channelRef, sender: { agent_id: 'leader', vendor: 'phantom', human: false, team: true }, external: false, origin_bridge: LEADER_BRIDGE_ID };
  }
  return {
    async pending(): Promise<{ requestId: string; envelope: BusEnvelope; replyText?: string }[]> {
      try { return await transaction(async (state, at) => {
        // A failed sole-writer append retained the authenticated input before
        // it became inbox-durable. Retry only that exact current-owner receipt,
        // through the trusted idempotent helper; never fall back to direct IO.
        const retryPolicy = currentPolicy();
        const recoverable = options.appendInbox ? Object.entries(state.routes).filter(([, route]) =>
          route.channel === 'slack' && !route.inbox && !route.bus && !route.reply && route.message.to === 'leader' &&
          at - route.receivedAt < route.message.ttl && currentOwner(route, retryPolicy)) : [];
        const start = recoverable.length ? (state.inboxRetryCursor ?? 0) % recoverable.length : 0;
        const batch = [...recoverable.slice(start), ...recoverable.slice(0, start)].slice(0, INBOX_RECOVERY_BATCH);
        state.inboxRetryCursor = recoverable.length ? (start + batch.length) % recoverable.length : 0;
        if (batch.length) save(state); // crash-safe scheduling only, never durability
        for (const [requestId, route] of batch) {
          try {
            const fresh = now();
            const verified = { channel: route.channel, id: route.recipient };
            const policy = currentPolicy();
            const envelope = policy ? routeLeaderMessage(route.message, verified, policy.configSource) : null;
            const text = envelope ? inputText(envelope) : null;
            if (!text || !envelope || hash([envelope, route.recipient]) !== route.fingerprint || fresh < route.receivedAt || fresh - route.receivedAt >= envelope.ttl) continue;
            await appendInbox(requestId, route, text);
            const acceptedAt = now();
            if (!currentOwner(route) || acceptedAt < route.receivedAt || acceptedAt - route.receivedAt >= envelope.ttl) continue;
            route.inbox = true; save(state);
          } catch { /* Missing/uncertain proof stays retained; later routes still get a turn. */ }
        }
        // Durable inbox acceptance survives a full or unavailable bus. Recover
        // its pending mirror from the authenticated saved route, never raw bus
        // labels, and keep the original receipt time and envelope identity.
        for (const route of Object.values(state.routes)) {
          const mirrorAt = now();
          if (route.inbox && !route.bus && route.message.to === 'leader' &&
              mirrorAt >= route.receivedAt && mirrorAt - route.receivedAt < route.message.ttl &&
              currentOwner(route)) {
            route.bus = publish({ ...route.message, origin_bridge: LEADER_BRIDGE_ID }, route.receivedAt);
          }
        }
        const readyPolicy = currentPolicy();
        return Object.entries(state.routes).flatMap(([requestId, route]) =>
          route.inbox && route.bus && route.message.to === 'leader' && !route.reply?.delivered && !route.reply?.attempted && currentOwner(route, readyPolicy)
            ? [{ requestId, envelope: route.message, ...(route.reply ? { replyText: route.reply.text } : {}) }] : []);
      }); } catch { return []; }
    },
    async ingest(input: LeaderNetworkInput): Promise<LeaderNetworkResult> {
      const envelope = routeLeaderMessage(input.message, input.verifiedSender, options.configSource, input.addressedAgent);
      if (!envelope) return { status: 'ignored' };

      const text = inputText(envelope);
      if (!text || !envelope.channel_ref) return { status: 'refused', reason: 'Invalid leader input.' };
      const requestId = hash([envelope.channel, envelope.id]);
      try { return await transaction(async (state, at) => {
        const receivedAt = input.receivedAt === undefined ? at : input.receivedAt;
        if (!Number.isSafeInteger(receivedAt) || receivedAt < 0 || receivedAt > at || at - receivedAt >= envelope.ttl) return { status: 'refused', reason: 'Invalid or expired adapter receipt.' };
        let route = state.routes[requestId];
        const duplicate = route?.inbox === true && route.bus === true;
        if (!route) {
          // Completed route metadata is bounded, but its durable outbox marker
          // remains a tombstone: a transport replay cannot generate/send again.
          const outbox = read(join(leaderDir, 'MASON-OUTBOX.md'), MAX_RECORD_BYTES);
          if (outbox?.split('\n').some(line => line.startsWith('## ') && line.endsWith(`[leader-network:reply-${requestId}]`))) return { status: 'duplicate', requestId };
          route = { channel: input.verifiedSender.channel, recipient: input.verifiedSender.id, channelRef: envelope.channel_ref!, receivedAt, inbox: input.inboxAlreadyRecorded === true, bus: false, fingerprint: hash([envelope, input.verifiedSender.id]), message: envelope };
          state.routes[requestId] = route;
          state.lastMasonAt = Math.max(state.lastMasonAt ?? 0, receivedAt);
          save(state);
        } else if (route.fingerprint !== hash([envelope, input.verifiedSender.id]) || route.channel !== input.verifiedSender.channel || route.recipient !== input.verifiedSender.id || route.channelRef !== envelope.channel_ref) return { status: 'refused', reason: 'Conflicting request identity.' };
        if (envelope.to !== 'leader') {
          route.bus = publish(envelope, route.receivedAt);
          return { status: route.bus ? 'accepted' : 'unavailable', requestId, envelope };
        }
        if (!route.inbox) {
          await appendInbox(requestId, route, text);
          route.inbox = true; save(state);
        }
        if (!route.bus) {
          route.bus = publish({ ...envelope, origin_bridge: LEADER_BRIDGE_ID }, route.receivedAt);
          if (!route.bus) return { status: 'unavailable', requestId, recorded: true };
        }
        return { status: duplicate ? 'duplicate' : 'accepted', requestId, envelope };
      }); } catch { return { status: 'unavailable' }; }
    },
    async reply(requestId: string, body: string): Promise<LeaderNetworkResult> {
      const text = cleanText(body);
      if (!/^[a-f0-9]{64}$/.test(requestId) || !text) return { status: 'refused', reason: 'Invalid reply.' };
      try { return await transaction(async (state, at) => {
        const route = state.routes[requestId];
        if (!route?.inbox || !owner({ channel: route.channel, id: route.recipient }, options.configSource)) return { status: 'refused', reason: 'No verified request route.' };
        const fingerprint = hash(text);
        if (route.reply && route.reply.fingerprint !== fingerprint) return { status: 'refused', reason: 'A different reply already owns this request.' };
        route.reply ??= { text, fingerprint, at, recorded: false, published: false, delivered: false, attempted: false };
        const reply = route.reply;
        if (reply.delivered) return { status: 'duplicate', requestId };
        if (reply.attempted) return { status: 'drafted', requestId, reason: 'Delivery outcome unknown; reconcile before retry.' };
        const envelope = replyEnvelope(requestId, route, text);
        if (!reply.recorded) {
          appendRecord(join(leaderDir, 'MASON-OUTBOX.md'), `reply-${requestId}`, `## ${new Date(reply.at).toISOString()} [leader-network:reply-${requestId}]\nLeader: ${text.split('\n').map(escapeInboxContinuation).join('\n')}`);
          reply.recorded = true; save(state);
        }
        if (!reply.published) { reply.published = publish(envelope); save(state); }
        if (!reply.published) return { status: 'unavailable', requestId };
        reply.attempted = true; save(state);
        const result = await deliver(route, envelope);
        reply.delivered = result.status === 'sent';
        if (!result.ambiguous) reply.attempted = false;
        return { ...result, requestId, envelope };
      }); } catch { return { status: 'unavailable' }; }
    },
    /** Planning keeps running while away. Each owner channel gets one digest per UTC day. */
    async tick(digest: string, plan?: () => Promise<void>): Promise<{ away: boolean | null; planning: 'completed' | 'failed'; sent: number; pending: number }> {
      let planning: 'completed' | 'failed' = 'completed';
      try { await plan?.(); } catch { planning = 'failed'; }
      const text = cleanText(digest);
      try { return await transaction(async (state, at) => {
        const away = at - (state.lastMasonAt ?? state.startedAt) >= LEADER_AWAY_MS;
        const result = { away, planning, sent: 0, pending: 0 };
        if (!away || !text) return result;
        const day = new Date(at).toISOString().slice(0, 10);
        for (const identity of parseMasonIdentities(options.configSource)) {
          const key = hash([day, identity.channel, identity.id]);
          if (state.digests[key]?.sent) continue;
          if (state.digests[key]?.attempted) { result.pending++; continue; }
          const route = { channel: identity.channel, recipient: identity.id, channelRef: identity.id };
          const envelope = state.digests[key]?.envelope ?? { ...replyEnvelope(key, route, text), id: `leader-digest-${key.slice(0, 32)}`, priority: 'P2' as const, body: { kind: 'leader-away-digest', day, text: `Leader: ${text}` } };
          state.digests[key] ??= { at, sent: false, attempted: false, envelope }; save(state);
          appendRecord(join(leaderDir, 'MASON-OUTBOX.md'), `digest-${key}`, `## ${new Date(at).toISOString()} [leader-network:digest-${key}]\nLeader: ${text.split('\n').map(escapeInboxContinuation).join('\n')}`);
          if (!publish(envelope)) { result.pending++; continue; }
          state.digests[key].attempted = true; save(state);
          const delivered = await deliver(route, envelope);
          state.digests[key].sent = delivered.status === 'sent';
          if (!delivered.ambiguous) state.digests[key].attempted = false;
          save(state);
          if (delivered.status === 'sent') result.sent++;
          else result.pending++;
        }
        // Bounded rolling receipts; retain the last week, including today's sent slots.
        for (const [key, receipt] of Object.entries(state.digests)) if (at - receipt.at > 7 * DAY_MS) delete state.digests[key];
        return result;
      }); } catch { return { away: null, planning, sent: 0, pending: 1 }; }
    },
  };
}
