import { readOwnerChatReceipts, ownerChatRoot, ownerChatReceiptState, type OwnerChatReceipt } from './chat-owner-receipts.js';
/**
 * RQ-BUS-UNIFY-1: DMs, channels, handoffs and priority wake on the one bus.
 *
 * Every send is one `appendBusInbox` post to the existing durable store, with
 * the channel metadata group filled in from the identity registry. Wakes go
 * through the existing post-accept hook (`createBusWakeHook`) into the
 * routing-only wake queue under `~/.ashlr-runs/bus`. Nothing here dispatches
 * work, runs an engine or grants authority: identities are routing names,
 * bodies are untrusted data, and consumers keep their own admission checks.
 *
 * Addresses (all flat routing labels; the wire envelope is unchanged):
 *   DM       to `agent:<handle>`                channel `bus`
 *   channel  to `group:<channel>:<topic>`       channel `bus`   (bus-group address)
 *   label    to `<routing label>`               channel `bus`   (note or context)
 *   handoff  to `agent:<handle>`                channel `handoff`, body `worker-handoff`
 *   wake     to `agent:<handle>`                channel `bus`,   body `wake`
 */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, scanBusInbox, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  type BusInboxOptions, type BusInboxPost } from '../fleet/bus-inbox.js';
import { BUS_PRIORITIES, isClaimableWork, type BusEnvelope, type BusPriority } from '../fleet/bus-envelope.js';
import { groupAddress, isGroupPresenceBody } from '../fleet/bus-group.js';
import { isWorkerHandoffBody } from '../fleet/handoff-body.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { createBusWakeHook, type BusWakeResult } from '../fleet/bus-wake.js';
import { busWakeQueueEnqueue, enqueueBusWake, readBusWakes, type BusWakeRow } from '../fleet/bus-wake-queue.js';
import { isFleetJobId } from '../fleet/runs-job-detail.js';
import { LEADERS_ADDRESS } from '../fleet/bus-leader-inbox.js';
import { scrubSecrets } from '../util/scrub.js';
import { localWriteGate } from './send-gate.js';
import { coordinationRowBlocks, listCoordination } from './claim-store.js';
import { BUS_V2_TEXT_MAX, busBodyThread, contextBodySchema, noteBodySchema, wakeBodySchema, workPostBodySchema,
  workStatusBodySchema, type Participant, type WorkJob } from './bus-v2-schema.js';
import { readBusWorkFeed, runtimeProvider, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import {
  AGENT_ADDRESS_PREFIX, agentAddressMatcher, agentChannelNameSchema, agentLabels, findAgentChannel, readAgentRegistry,
  RESERVED_PREFIXES, resolveAgent, type AgentIdentity, type AgentIdentityKeyFor, type AgentRegistry,
  type AgentRegistryOptions,
} from './bus-identity.js';

export const UNIFIED_BUS_ORIGIN = 'agent-bus';
export const DEFAULT_DM_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_WORK_TTL_MS = 7 * 24 * 60 * 60_000;
/** Work announcements and statuses default to the fleet work sink label. */
export const DEFAULT_WORK_ADDRESS = LEADERS_ADDRESS;
export const MAX_UNIFIED_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_CHANNEL_TOPIC = 'general';
/** Bounded scan: the whole retained store, at the reader's page size. */
const MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD = /^[\x21-\x7e]{1,128}$/;

export interface UnifiedBusOptions extends BusInboxOptions, AgentRegistryOptions {
  /** Parent of `bus/wake-queue.jsonl`; default ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsRoot?: string;
  /** Hop log for wakes; defaults beside the store when `root` is set. */
  hoplogFile?: string;
}

export type WakeOutcome = 'not-requested' | BusWakeResult['wake'];
export type UnifiedSendResult =
  | { status: 'posted' | 'duplicate'; id: string; cursor: number; to: string; wake: WakeOutcome;
      /**
       * Terminal `work.status` only: distinct live claim-holder wake hints
       * recorded for the job's keys. Absent when the fan-out did not run;
       * null when the live claim set could not be read (unknown, not none).
       */
      claimHoldersWoken?: number | null }
  | { status: 'invalid' | 'unknown-sender' | 'unknown-recipient' | 'not-member' | 'refused' |
      'unavailable' | 'retryable' | 'full' | 'conflict'; reason: string };

interface SendCommon {
  /** Sender handle, `agent:<handle>`, stable id or alias. */
  from: string;
  priority?: BusPriority;
  ttl?: number;
  /** Stable id makes retries deduplicate; a retry also re-attempts a failed wake. */
  id?: string;
  /**
   * Priority wake. P0 always wakes. Otherwise this flag decides, defaulting to
   * true for P1 and handoffs and false for P2/P3.
   */
  wake?: boolean;
}
export interface DirectMessageInput extends SendCommon { to: string; text: string; thread?: string; refs?: string[] }
export interface ChannelPostInput extends SendCommon { channel: string; topic?: string; text: string; thread?: string; refs?: string[] }
export interface LabelPostInput extends SendCommon {
  /** Plain routing label the message addresses; the reserved prefixes are refused. */
  to: string;
  text: string;
  /** v2 conversational body kind; default `note`. */
  kind?: 'note' | 'context';
  thread?: string;
  refs?: string[];
}
export interface HandoffInput extends SendCommon { to: string; taskId: string; prompt: string }

const refuse = (status: Exclude<UnifiedSendResult['status'], 'posted' | 'duplicate'>, reason: string): UnifiedSendResult =>
  ({ status, reason });

/** P0 is a priority wake that cannot be suppressed; handoffs and P1 wake by default. */
export function shouldWake(priority: BusPriority, requested: boolean | undefined, handoff = false): boolean {
  if (priority === 'P0') return true;
  return requested ?? (handoff || priority === 'P1');
}

function text(value: unknown, max = BUS_V2_TEXT_MAX): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function registry(options: UnifiedBusOptions): AgentRegistry | UnifiedSendResult {
  const read = readAgentRegistry(options);
  return read.status === 'ok' ? read.registry : refuse('unavailable', read.reason);
}

function common(input: SendCommon, defaults: { priority: BusPriority; ttl: number }): UnifiedSendResult | {
  priority: BusPriority; ttl: number; id: string } {
  const priority = input.priority ?? defaults.priority;
  if (!BUS_PRIORITIES.includes(priority)) return refuse('invalid', 'Priority must be P0, P1, P2 or P3.');
  const ttl = input.ttl ?? defaults.ttl;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_UNIFIED_TTL_MS) return refuse('invalid', 'TTL must be 1 ms to 30 days.');
  const id = input.id ?? `ab-${randomUUID()}`;
  if (!ID.test(id) || scrubSecrets(id) !== id) return refuse('invalid', 'Message id must be a 1-128 char label.');
  if (input.wake !== undefined && typeof input.wake !== 'boolean') return refuse('invalid', 'Wake must be a boolean.');
  return { priority, ttl, id };
}

/** The sender's vendor is its most recently seen runtime's provider, else `phantom`. */
function vendorOf(identity: AgentIdentity): string {
  return runtimeProvider(identity) ?? 'phantom';
}

function hoplogFile(options: UnifiedBusOptions): string | undefined {
  return options.hoplogFile ?? (options.root ? join(options.root, 'bus', 'hops.jsonl') : undefined);
}

async function post(envelope: BusEnvelope, wake: boolean, options: UnifiedBusOptions): Promise<UnifiedSendResult> {
  const blocked = localWriteGate();
  if (blocked) return refuse('refused', blocked.reason);
  if (scrubSecrets(JSON.stringify(envelope.body)) !== JSON.stringify(envelope.body)) {
    return refuse('refused', 'Message text is credential-shaped; use a Phantom Secrets phm_<name> reference.');
  }
  const result: BusInboxPost = appendBusInbox(envelope, { root: options.root, now: options.now });
  if (result.status !== 'posted' && result.status !== 'duplicate') {
    return refuse(result.status, result.status === 'conflict'
      ? 'Message id already exists with different contents.' : `Bus store refused the message (${result.status}).`);
  }
  let wakeOutcome: WakeOutcome = 'not-requested';
  if (wake) {
    // Post-accept only. A duplicate retry re-attempts the wake; the queue dedupes by id.
    const hook = createBusWakeHook({ enqueue: busWakeQueueEnqueue(options.runsRoot), hoplogFile: hoplogFile(options) });
    wakeOutcome = (await hook({ id: envelope.id, from: envelope.from, to: envelope.to })).wake;
  }
  return { status: result.status, id: result.id, cursor: result.cursor, to: envelope.to, wake: wakeOutcome };
}

function metadata(sender: AgentIdentity, channel: 'bus' | 'handoff', channelRef: string) {
  return {
    channel, channel_ref: channelRef,
    sender: { agent_id: sender.id, vendor: vendorOf(sender), human: false, team: true },
    external: false, origin_bridge: UNIFIED_BUS_ORIGIN,
  } as const;
}

function noteBody(input: { kind?: 'note' | 'context'; text: string; thread?: string; refs?: string[] }) {
  return {
    kind: input.kind ?? 'note', text: input.text,
    ...(input.thread === undefined ? {} : { thread: input.thread }),
    ...(input.refs === undefined ? {} : { refs: input.refs }),
  };
}

function noteFields(input: { text: unknown; thread?: unknown; refs?: unknown }): string | null {
  if (!text(input.text)) return `Text must be 1-${BUS_V2_TEXT_MAX} characters.`;
  if (input.thread !== undefined && (typeof input.thread !== 'string' || !THREAD.test(input.thread))) return 'Thread must be a printable label.';
  if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 32 ||
    input.refs.some(ref => typeof ref !== 'string' || ref.length < 1 || ref.length > 256))) return 'Refs must be up to 32 short strings.';
  return null;
}

/** One-to-one message between two registered identities. */
export async function sendDirectMessage(input: DirectMessageInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_DM_TTL_MS });
  if ('status' in base) return base;
  const problem = noteFields(input);
  if (problem) return refuse('invalid', problem);
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const recipient = resolveAgent(reg, input.to);
  if (!recipient) return refuse('unknown-recipient', 'Recipient is not a registered identity.');
  const pair = [sender.handle, recipient.handle].sort();
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to: `${AGENT_ADDRESS_PREFIX}${recipient.handle}`,
    priority: base.priority, ttl: base.ttl, body: noteBody(input), ...metadata(sender, 'bus', `dm:${pair.join(':')}`),
  }, shouldWake(base.priority, input.wake), options);
}

/** Group message. The sender must be a current member; the address is the bus-group room. */
export async function postChannelMessage(input: ChannelPostInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_DM_TTL_MS });
  if ('status' in base) return base;
  const problem = noteFields(input);
  if (problem) return refuse('invalid', problem);
  if (!agentChannelNameSchema.safeParse(input.channel).success) return refuse('invalid', 'Invalid channel name.');
  let to: string;
  try { to = groupAddress(input.channel, input.topic ?? DEFAULT_CHANNEL_TOPIC); }
  catch { return refuse('invalid', 'Invalid channel topic.'); }
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const channel = findAgentChannel(reg, input.channel);
  if (!channel) return refuse('unknown-recipient', 'Channel does not exist.');
  if (!channel.members.includes(sender.handle)) return refuse('not-member', 'Sender is not a member of this channel.');
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to, priority: base.priority, ttl: base.ttl,
    body: noteBody(input), ...metadata(sender, 'bus', to),
  }, shouldWake(base.priority, input.wake), options);
}

/**
 * Post a v2 `note` (or `context`) to a plain routing label — the address every
 * other send verb refuses by design: `dm` needs two registered identities,
 * `channel post` needs membership, `work post`/`status` need a job, and the
 * reserved prefixes (`agent:`, `group:`, `dm:`, `handoff:`) keep their
 * dedicated verbs. The label can be a sink (`leaders`), a shared topic
 * (`fleet.mesh`) or any label a subscriber reads through `comms bus read`,
 * `bus-follow` or an identity's alias matching; the sender is still a
 * registered identity and the mail carries the same sender metadata, scrub,
 * wake and append path as a DM. It is untrusted data: addressing a label
 * grants no authority, reaches no inbox unless the label is one of the
 * target's identity labels, and wakes only by the priority rules.
 */
export async function postLabelMessage(input: LabelPostInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_DM_TTL_MS });
  if ('status' in base) return base;
  const problem = noteFields(input);
  if (problem) return refuse('invalid', problem);
  const kind = input.kind ?? 'note';
  if (kind !== 'note' && kind !== 'context') return refuse('invalid', 'Kind must be note or context.');
  const to = input.to;
  if (typeof to !== 'string' || !THREAD.test(to) || scrubSecrets(to) !== to) {
    return refuse('invalid', 'Address must be a printable routing label.');
  }
  if (RESERVED_PREFIXES.some(prefix => to.toLowerCase().startsWith(prefix))) {
    return refuse('invalid', 'Address prefix is reserved for the dedicated verbs.');
  }
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const body = (kind === 'context' ? contextBodySchema : noteBodySchema).safeParse(noteBody({ ...input, kind }));
  if (!body.success) return refuse('invalid', 'Message is outside the v2 contract.');
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to, priority: base.priority, ttl: base.ttl,
    body: body.data, ...metadata(sender, 'bus', to),
  }, shouldWake(base.priority, input.wake), options);
}

/**
 * Hand a task to another identity. The body is exactly the `worker-handoff`
 * shape `phm fleet handoff-receive` reads, so the receiver runs it with its own
 * explicit argv and snapshot; nothing in the message selects a worker.
 */
export async function sendHandoff(input: HandoffInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P1', ttl: DEFAULT_HANDOFF_TTL_MS });
  if ('status' in base) return base;
  if (typeof input.taskId !== 'string' || !isFleetJobId(input.taskId)) return refuse('invalid', 'Task id must be a fleet job id.');
  if (!text(input.prompt)) return refuse('invalid', `Prompt must be 1-${BUS_V2_TEXT_MAX} characters.`);
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const recipient = resolveAgent(reg, input.to);
  if (!recipient) return refuse('unknown-recipient', 'Recipient is not a registered identity.');
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to: `${AGENT_ADDRESS_PREFIX}${recipient.handle}`,
    priority: base.priority, ttl: base.ttl, body: { kind: 'worker-handoff', taskId: input.taskId, prompt: input.prompt },
    ...metadata(sender, 'handoff', `handoff:${input.taskId}`),
  }, shouldWake(base.priority, input.wake, true), options);
}

export interface WakeRequestInput extends SendCommon {
  /** Registered agent to wake: handle, `agent:<handle>`, stable id or alias. */
  to: string;
  /** Why the target should read its inbox; the v2 wake body caps it at 512 chars. */
  reason: string;
  /** Optional job the wake concerns; joins the job's thread in message projections. */
  jobId?: string;
}

/**
 * Post a v2 `wake` body to one registered identity — the one body kind that is
 * itself a request to look at the bus. The mail lands in the target's inbox
 * like a DM, and the post always records the routing-only wake hint for its
 * addressee through the same post-accept hook every bus wake uses: the body's
 * purpose is the hint, so `wake: false` is refused rather than silently
 * ignored. `target` repeats the `agent:<handle>` address so the body and the
 * hint name the same agent under every label `readAgentWakes` matches. Like
 * every send it is untrusted data: a wake is a hint to read the inbox and
 * grants no authority.
 */
export async function sendWakeRequest(input: WakeRequestInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_DM_TTL_MS });
  if ('status' in base) return base;
  if (input.wake === false) return refuse('invalid', 'A wake request always records its hint.');
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const recipient = resolveAgent(reg, input.to);
  if (!recipient) return refuse('unknown-recipient', 'Recipient is not a registered identity.');
  const to = `${AGENT_ADDRESS_PREFIX}${recipient.handle}`;
  const body = wakeBodySchema.safeParse({
    kind: 'wake', target: to, reason: input.reason,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
  });
  if (!body.success) return refuse('invalid', 'Wake request is outside the v2 contract.');
  const pair = [sender.handle, recipient.handle].sort();
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to,
    priority: base.priority, ttl: base.ttl, body: body.data,
    ...metadata(sender, 'bus', input.jobId === undefined ? `dm:${pair.join(':')}` : `work:${input.jobId}`),
  }, true, options);
}

export interface WorkAnnouncementInput extends SendCommon {
  /** Routing label the announcement addresses; default `leaders`. */
  to?: string;
  jobId: string;
  title: string;
  repo: string;
  claimKeys: readonly string[];
  /** v2 provider; defaults to the sender identity's newest runtime provider. */
  provider?: Participant['provider'];
  dispatch?: { tier: 'fast' | 'mid' | 'work' | 'frontier'; scope: string; acceptance: string };
}
export interface WorkStatusInput extends SendCommon {
  /** Routing label the status addresses; default `leaders`. */
  to?: string;
  jobId: string;
  status: WorkJob['status'];
  detail?: string;
}

/** Work bodies address a plain routing label (default the fleet work sink), never an identity. */
function workRoute(to: string | undefined): string | UnifiedSendResult {
  const address = to ?? DEFAULT_WORK_ADDRESS;
  return THREAD.test(address) && scrubSecrets(address) === address
    ? address
    : refuse('invalid', 'Work address must be a printable routing label.');
}

/**
 * The work feed refuses its whole projection on a duplicate job id, a missing
 * provider or a foreign status owner, so a blind post can poison it for every
 * reader until the receipt expires. Verify against the live projection first;
 * an unreadable feed refuses the send rather than posting unchecked.
 */
function workFeedBlocked(feed: BusWorkFeedReadResult): UnifiedSendResult {
  if (feed.status === 'refused') {
    return refuse('refused', `Work feed is refused (${feed.reason})` +
      `${feed.receipt === undefined ? '' : ` at receipt ${feed.receipt.id}`}.`);
  }
  if (feed.status === 'retryable') return refuse('retryable', 'Work feed read is retryable.');
  if (feed.status === 'invalid') return refuse('invalid', 'Work feed read is invalid.');
  return refuse('unavailable', 'Work feed is unavailable.');
}

function workFeed(options: UnifiedBusOptions): BusWorkFeedReadResult {
  try { return readBusWorkFeed({ root: options.root, now: options.now }); }
  catch { return { status: 'unavailable', asOf: new Date().toISOString() }; }
}

/**
 * Announce a v2 `work.post`: the job the work feed projects until its TTL ends.
 * The provider defaults to the sender's newest runtime provider because the
 * feed refuses posts it cannot attribute; claim keys and dispatch scope are
 * schema-checked contract data, never execution authority.
 */
export async function announceWork(input: WorkAnnouncementInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_WORK_TTL_MS });
  if ('status' in base) return base;
  if (!Array.isArray(input.claimKeys)) return refuse('invalid', 'Claim keys must be an array of claim key strings.');
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const provider = input.provider ?? runtimeProvider(sender);
  if (provider === undefined) {
    return refuse('invalid', 'Work announcements need a provider: pass one or attach a runtime to the sender identity.');
  }
  const to = workRoute(input.to);
  if (typeof to !== 'string') return to;
  const body = workPostBodySchema.safeParse({
    kind: 'work.post', jobId: input.jobId, title: input.title, provider, repo: input.repo,
    claimKeys: [...input.claimKeys], ...(input.dispatch === undefined ? {} : { dispatch: input.dispatch }),
  });
  if (!body.success) return refuse('invalid', 'Work announcement is outside the v2 contract.');
  const feed = workFeed(options);
  if (feed.status !== 'ok') return workFeedBlocked(feed);
  if (feed.jobs.some(job => job.id === body.data.jobId)) {
    return refuse('conflict', 'Job id is already announced on the work feed.');
  }
  return post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to,
    priority: base.priority, ttl: base.ttl, body: body.data,
    ...metadata(sender, 'bus', `work:${body.data.jobId}`),
  }, shouldWake(base.priority, input.wake), options);
}

/** Feed statuses that end a job's claimable life; claim holders are told it ended, not just that it moved. */
const WORK_TERMINAL_STATUSES: ReadonlySet<WorkJob['status']> = new Set(['done', 'failed', 'terminated']);

/** Bound one status's holder fan-out; the wake queue is a hint buffer, not a broadcast channel. */
const CLAIM_HOLDER_WAKE_MAX = 32;

/** Deterministic per (status envelope, holder) so a reposted status dedupes instead of re-waking.
 * 32 hex chars stay under the wake id's secret-scrub thresholds (a longer digest reads as key material). */
function claimHolderWakeId(envelopeId: string, owner: string): string {
  return `wh-${createHash('sha256').update(`${envelopeId}\n${owner}`).digest('hex').slice(0, 32)}`;
}

/**
 * Post-accept fan-out for a terminal `work.status`: one routing-only wake hint
 * per distinct live claim owner whose keys overlap the job's declared claim
 * keys, so a worker holding `queue:`/`path:`/`repo:` scope learns the job ended
 * instead of waiting out its lease. Owners resolving to the status poster's own
 * identity are skipped — it posted the status itself — and labels of one
 * identity collapse to a single hint. The count is hints present after the
 * call (queued or already recorded); an enqueue that fails is best-effort and
 * never fails the posted status. Null means the live claim set could not be
 * read: unknown holders are never reported as none.
 */
function signalWorkClaimHolders(job: WorkJob, sender: AgentIdentity, registry: AgentRegistry,
  envelopeId: string, options: UnifiedBusOptions): number | null {
  if (job.claimKeys.length === 0) return 0;
  const listed = listCoordination(options.root, (options.now ?? Date.now)());
  // 'missing' is a verified-empty claim table: zero holders, not unknown.
  if (listed.source === 'unavailable') return null;
  const byHolder = new Map<string, string>();
  for (const row of listed.claims) {
    if (!row.live || !job.claimKeys.some(key => coordinationRowBlocks(row, key))) continue;
    const identity = resolveAgent(registry, row.owner);
    if (identity?.id === sender.id) continue;
    const holder = identity?.id ?? `label:${row.owner}`;
    if (!byHolder.has(holder)) byHolder.set(holder, row.owner);
    if (byHolder.size >= CLAIM_HOLDER_WAKE_MAX) break;
  }
  const from = `${AGENT_ADDRESS_PREFIX}${sender.handle}`;
  let recorded = 0;
  for (const owner of byHolder.values()) {
    try {
      // 'queued' and 'duplicate' both leave the hint present; only a throw means absent.
      enqueueBusWake({ kind: 'bus.send', id: claimHolderWakeId(envelopeId, owner), from, to: owner },
        { root: options.runsRoot, now: options.now });
      recorded += 1;
    } catch { /* A hint that cannot be written never fails the posted status. */ }
  }
  return recorded;
}

/**
 * Post a v2 `work.status` for a job the feed shows. Only the identity that
 * announced the job may move it — the same owner rule the projection enforces —
 * so this verb cannot post the status that would refuse the whole feed.
 */
export async function updateWorkStatus(input: WorkStatusInput, options: UnifiedBusOptions = {}): Promise<UnifiedSendResult> {
  const base = common(input, { priority: 'P2', ttl: DEFAULT_WORK_TTL_MS });
  if ('status' in base) return base;
  const reg = registry(options);
  if ('status' in reg) return reg;
  const sender = resolveAgent(reg, input.from);
  if (!sender) return refuse('unknown-sender', 'Sender is not a registered identity.');
  const to = workRoute(input.to);
  if (typeof to !== 'string') return to;
  const body = workStatusBodySchema.safeParse({
    kind: 'work.status', jobId: input.jobId, status: input.status,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
  if (!body.success) return refuse('invalid', 'Work status is outside the v2 contract.');
  const feed = workFeed(options);
  if (feed.status !== 'ok') return workFeedBlocked(feed);
  const job = feed.jobs.find(candidate => candidate.id === body.data.jobId);
  if (!job) return refuse('invalid', 'Work status names a job the feed does not show.');
  if (resolveAgent(reg, job.owner)?.id !== sender.id) {
    return refuse('refused', 'Only the identity that announced the job may post its status.');
  }
  const sent = await post({
    id: base.id, from: `${AGENT_ADDRESS_PREFIX}${sender.handle}`, to,
    priority: base.priority, ttl: base.ttl, body: body.data,
    ...metadata(sender, 'bus', `work:${body.data.jobId}`),
  }, shouldWake(base.priority, input.wake), options);
  // A terminal status also hints every live claim holder on the job's keys;
  // --no-wake opts out of that fan-out as well as the message's own hint. A
  // fan-out fault leaves holder state unknown — it never fails the posted send.
  if ((sent.status !== 'posted' && sent.status !== 'duplicate') ||
      input.wake === false || !WORK_TERMINAL_STATUSES.has(body.data.status)) return sent;
  let claimHoldersWoken: number | null;
  try {
    claimHoldersWoken = signalWorkClaimHolders(job, sender, reg, sent.id, options);
  } catch {
    claimHoldersWoken = null;
  }
  return { ...sent, claimHoldersWoken };
}

export type InboxKind = 'dm' | 'channel' | 'handoff' | 'legacy';
export interface InboxMessage {
  cursor: number;
  receivedAt: number;
  kind: InboxKind;
  priority: BusPriority;
  /** Registered handle of the sender label, or null. A label is never authentication. */
  fromAgent: string | null;
  /** Channel name for channel posts. */
  channel: string | null;
  envelope: BusEnvelope;
  /**
   * Claimable work and worker-handoff bodies only: whether a taken
   * message-id claim or a live coordination hold provably covers the exact
   * receipt — the same evidence `bus show` reports. `held` false is proof
   * of free; null means a hold store could not be read (unknown, never
   * proven free). Absent on every other body kind.
   */
  held?: boolean | null;
  /** Owner label of the blocking claim when held and known; null otherwise. */
  holder?: string | null;
}
export type InboxPage = { status: 'ok'; agent: string; messages: InboxMessage[]; nextCursor: number;
    /** Every filter-matched row across the whole scan, present only when the
     * read asked for it (`page.matched`); `messages` still caps at `limit`. */
    matched?: number } |
  { status: 'invalid' | 'unknown-agent' | 'unavailable' | 'retryable'; reason: string };

const BUS_BODY_SUMMARY_MAX = 200;

/** Scrub and flatten one untrusted field into single-line summary text. */
function busSummaryField(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const busSummaryClip = (value: string): string =>
  value.length > BUS_BODY_SUMMARY_MAX ? `${value.slice(0, BUS_BODY_SUMMARY_MAX - 1)}…` : value;

/** Scrubbed, single-line text of one string field; null when absent or empty. */
function summaryField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) return null;
  const cleaned = busSummaryField(value);
  return cleaned === '' ? null : cleaned;
}

/** A finite number rendered for a summary line; null for anything else. */
function summaryNumber(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/**
 * A one-line read of a bus body for inbox surfaces, or null when the body has
 * no typed content worth summarizing (the caller keeps its own fallback, for
 * example a bounded raw JSON render). `note`, `context` and `worker-handoff`
 * return their message text, which may span lines; every other recognized
 * kind composes a single scrubbed line as `<kind> <subject>: <payload>` —
 * the v2 work/wake bodies plus the channel, leader, peer, group, cos and
 * incident notices that share the store (`interjection`, `owner-thread`,
 * `comms-reply`, `leader.*`, `peer.*`, `group.*`, `cos-*`, `order-merged`,
 * `inbox-ack`, `needs_mason.resolved`, `ci.failed-scheduled-run`,
 * `worker-exit`, `selector.picks`, `browser`, `slack-coordination`,
 * `waste-high`, `meter-flat`, `lane-released`, `forum.mention`,
 * `desktopctl`, `apps-*.v1`, `reset-watch.*.v1`, `fleet-event`,
 * `fleet-self-loop-pass`, `org.membership`, `work-board-notify`,
 * `desktop.intent`, `apps-control`, `planner-cycle-result.v1`,
 * `fleet.graph-observe.v1`, `guardian-drain.v1`, `locus-peers`, legacy
 * `work`, kindless `{inReplyTo, text}` replies and protocol-v1 transport
 * bodies). Notices that key their discriminator as `type` or `schema`
 * instead of `kind` lend it to the same switch.
 * Claim tokens and `work.result` queueId/receiptId never appear: they are
 * private coordination data, not message content, so the secret-bearing kinds
 * return at least their kind literal rather than ever falling back to a raw
 * render.
 */
export function busBodySummary(body: unknown): string | null {
  return summarizeBusBody(body, 0);
}

/** Nested bodies (a `group.message` room payload) summarize at most this deep. */
const BUS_BODY_SUMMARY_MAX_DEPTH = 4;

function summarizeBusBody(body: unknown, depth: number): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  const field = (key: string): string | null => summaryField(record, key);
  const num = (key: string): string | null => summaryNumber(record, key);
  const parts = (...values: (string | null)[]): string | null => {
    const kept = values.filter((value): value is string => value !== null);
    return kept.length === 0 ? null : busSummaryClip(kept.join(' '));
  };
  /** `a — b` when both sides exist, else whichever does; the status/outcome + detail/reason pairing. */
  const pair = (head: string | null, tail: string | null): string | null =>
    head === null ? tail : tail === null ? head : `${head} — ${tail}`;
  const composed = (head: string, detail: string | null): string =>
    busSummaryClip(detail === null ? head : `${head}: ${detail}`);
  /** `<kind> <labels>: <detail>` for flat notification bodies; null when nothing readable. */
  const simple = (kind: string, labels: readonly string[], detail?: string | readonly string[]): string | null => {
    const head = parts(kind, ...labels.map(label => field(label)));
    const detailText = detail === undefined ? null
      : typeof detail === 'string' ? field(detail)
      : detail.map(key => field(key)).find(value => value !== null) ?? null;
    if (head === kind && detailText === null) return null;
    return composed(head ?? kind, detailText);
  };
  let kind = str('kind');
  if (kind === null) {
    // Bus-transport v1 bodies carry protocol.kind with no top-level kind; the
    // payload stays opaque (it can be large), only its printable ref is read.
    const proto = record['protocol'];
    if (proto !== null && typeof proto === 'object' && !Array.isArray(proto)) {
      const p = proto as Record<string, unknown>;
      const pk = summaryField(p, 'kind');
      if (pk !== null) {
        return composed(parts('protocol', pk, summaryField(p, 'topic')) ?? 'protocol', summaryField(p, 'payload_ref'));
      }
    }
    // Kindless notices key their discriminator as `type` or `schema`
    // (forum.mention, planner-cycle-result.v1, fleet.graph-observe.v1,
    // guardian-drain.v1); lend it to the same switch.
    kind = str('type') ?? str('schema') ?? '';
    if (kind === '') {
      // The locus peer relay keys its untrusted payload by `source`; `data` is
      // opaque peer content and never enters a summary.
      if (str('source') === 'locus-peers') {
        const head = parts('locus-peers', field('sessionId'));
        const trust = field('trust');
        return head === 'locus-peers' && trust === null ? 'locus-peers' : composed(head ?? 'locus-peers', trust);
      }
      // Kindless text bodies — `phm comms bus reply` posts {inReplyTo, text} —
      // render as their message text, the same read `note` gets.
      const plain = str('text');
      return plain === null ? null : scrubSecrets(plain);
    }
  }
  switch (kind) {
    case 'note':
    case 'context': {
      const bodyText = str('text');
      return bodyText === null ? null : scrubSecrets(bodyText);
    }
    case 'worker-handoff': {
      const prompt = str('prompt');
      if (prompt === null) return null;
      const taskId = field('taskId');
      return `handoff task${taskId === null ? '' : ` ${taskId}`}: ${scrubSecrets(prompt)}`;
    }
    case 'work.post': {
      const jobId = field('jobId'), title = field('title'), repo = field('repo');
      if (jobId === null && title === null && repo === null) return null;
      const head = jobId === null ? 'work.post' : `work.post ${jobId}`;
      return composed(head, parts(title, repo === null ? null : `(${repo})`));
    }
    case 'work.status': {
      const jobId = field('jobId');
      const state = pair(field('status'), field('detail'));
      if (jobId === null && state === null) return null;
      return composed(jobId === null ? 'work.status' : `work.status ${jobId}`, state);
    }
    case 'work.result': {
      const jobId = field('jobId');
      const outcome = pair(field('outcome'), field('reason'));
      // queueId/receiptId are private dispatch-journal data: never let this kind
      // fall back to a raw render, even when every field is unreadable.
      if (jobId === null && outcome === null) return 'work.result';
      return composed(jobId === null ? 'work.result' : `work.result ${jobId}`, outcome);
    }
    case 'work.claim': {
      const jobId = field('jobId'), action = parts(field('op'), field('claimKey'));
      // The fencing token is a bearer capability: this kind never falls back
      // to a raw render, even when every field is unreadable.
      if (jobId === null && action === null) return 'work.claim';
      return composed(jobId === null ? 'work.claim' : `work.claim ${jobId}`, action);
    }
    case 'work.release': {
      const claimKey = field('claimKey'), outcome = field('outcome');
      if (claimKey === null && outcome === null) return 'work.release';
      return composed(claimKey === null ? 'work.release' : `work.release ${claimKey}`, outcome);
    }
    case 'wake': {
      const target = field('target'), reason = field('reason'), jobId = field('jobId');
      const head = parts('wake', target, jobId === null ? null : `(${jobId})`);
      if (head === 'wake' && reason === null) return null;
      return composed(head ?? 'wake', reason);
    }
    case 'work':
      return simple('work', [], 'text');
    case 'interjection':
      return simple('interjection', ['channel'], 'text');
    case 'owner-thread': {
      const channel = field('channel');
      const bodyText = field('text') ?? (record['redacted'] === true ? 'redacted' : null);
      if (channel === null && bodyText === null) return null;
      return composed(parts('owner-thread', channel) ?? 'owner-thread', bodyText);
    }
    case 'comms-reply':
      return simple('comms-reply', [], 'text');
    case 'slack-coordination':
      return simple('slack-coordination', ['messageType', 'routeMode'], 'text');
    case 'order-merged':
      return simple('order-merged', ['channel'], 'text');
    case 'inbox-ack':
      return simple('inbox-ack', ['channel'], 'text');
    case 'needs_mason.resolved':
      return simple('needs_mason.resolved', ['itemId'], ['reply', 'item']);
    case 'leader-reply':
      return simple('leader-reply', ['requestId'], 'text');
    case 'leader.reply':
      return simple('leader.reply', ['rq'], 'text');
    case 'leader-away-digest':
      return simple('leader-away-digest', ['day'], 'text');
    case 'leader.owner-message':
      return simple('leader.owner-message', ['rq'], 'text');
    case 'leader.escalation':
      return simple('leader.escalation', ['rq', 'category'], 'text');
    case 'leader.assignment':
      return simple('leader.assignment', ['rq', 'lane'], 'text');
    case 'cos-drafted':
      return simple('cos-drafted', ['id', 'provider']);
    case 'cos-blocked':
      return simple('cos-blocked', ['id'], 'reason');
    case 'group.presence':
      return simple('group.presence', [], 'state');
    case 'peer.draft':
      return simple('peer.draft', ['action', 'name'], 'status');
    case 'peer.escalation':
      return simple('peer.escalation', ['origin'], 'reason');
    case 'apps-changes.event.v1':
      return simple('apps-changes.event.v1', ['type', 'app'], ['state', 'outcome']);
    case 'peer.plan': {
      const results = record['results'];
      if (!Array.isArray(results)) return null;
      const statuses = [...new Set(results.flatMap(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
        const status = summaryField(item as Record<string, unknown>, 'status');
        return status === null ? [] : [status];
      }))];
      const detail = statuses.length === 0 ? `${results.length} results` : `${results.length} results (${statuses.join(', ')})`;
      return composed('peer.plan', detail);
    }
    case 'peer.message': {
      const peer = record['peer'];
      if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) return null;
      const p = peer as Record<string, unknown>;
      const from = summaryField(p, 'fromAgent');
      const to = summaryField(p, 'toAgent') ?? summaryField(p, 'channel');
      const route = from !== null && to !== null ? `${from}->${to}` : from ?? to;
      const head = parts('peer.message', summaryField(p, 'kind'), route);
      return composed(head ?? 'peer.message', summaryField(p, 'text'));
    }
    case 'group.message': {
      if (!Object.hasOwn(record, 'value')) return null;
      const value = record['value'];
      const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
      let inner: string | null = null;
      if (typeof value === 'string') {
        inner = busSummaryField(value);
      } else if (isObject && depth < BUS_BODY_SUMMARY_MAX_DEPTH) {
        inner = summarizeBusBody(value, depth + 1);
      }
      if (inner === null && isObject) inner = summaryField(value as Record<string, unknown>, 'text');
      if (inner !== null) {
        const flat = busSummaryField(inner);
        inner = flat === '' ? null : flat;
      }
      return composed('group.message', inner);
    }
    case 'forum.mention':
      return simple('forum.mention', ['channelId'], 'excerpt');
    case 'ci.failed-scheduled-run': {
      const runId = num('runId'), attempt = num('attempt'), failed = num('failedJobCount');
      const workflow = field('workflow'), branch = field('branch');
      const head = parts('ci.failed-scheduled-run', field('repo'),
        runId === null ? null : `run ${runId}`, attempt === null ? null : `attempt ${attempt}`);
      if (head === 'ci.failed-scheduled-run' && workflow === null && branch === null && failed === null) return null;
      return composed(head ?? 'ci.failed-scheduled-run',
        pair(failed === null ? null : `${failed} failed jobs`, parts(workflow, branch === null ? null : `on ${branch}`)));
    }
    case 'worker-exit': {
      const exitCode = num('exitCode');
      const succeeded = record['succeeded'];
      const state = succeeded === true ? 'succeeded' : succeeded === false ? 'failed' : null;
      const verification = field('verification');
      const head = parts('worker-exit', field('taskId') ?? field('inReplyTo'));
      if (head === 'worker-exit' && exitCode === null && state === null && verification === null) return null;
      return composed(head ?? 'worker-exit',
        pair(parts(exitCode === null ? null : `exit ${exitCode}`, state), verification));
    }
    case 'selector.picks': {
      const picks = record['picks'];
      if (!Array.isArray(picks)) return null;
      const ids = picks.flatMap(item => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
        const id = summaryField(item as Record<string, unknown>, 'id');
        return id === null ? [] : [id];
      }).slice(0, 8);
      return composed('selector.picks', ids.length === 0 ? `${picks.length} picks` : `${picks.length} picks: ${ids.join(', ')}`);
    }
    case 'browser': {
      const outcome = field('outcome'), detailText = field('detail');
      const head = parts('browser', field('browser'), field('action'));
      if (head === 'browser' && outcome === null && detailText === null) return null;
      return composed(head ?? 'browser', pair(outcome, detailText));
    }
    case 'apps-watch.observation.v1':
    case 'apps-watch.summary.v1': {
      // Watched-app lists are arrays of untrusted rows; only their count is summarized.
      const watched = Array.isArray(record['apps']) ? record['apps']
        : Array.isArray(record['observedState']) ? record['observedState']
        : Array.isArray(record['lastObservedState']) ? record['lastObservedState'] : null;
      const healthy = record['healthy'];
      const head = parts(kind,
        healthy === true ? 'healthy' : healthy === false ? 'unhealthy' : field('outcome'),
        num('cycle') === null ? null : `cycle ${num('cycle')}`,
        num('cycles') === null ? null : `${num('cycles')} cycles`,
        watched === null ? null : `${watched.length} app${watched.length === 1 ? '' : 's'}`);
      const detail = parts(
        num('recoveries') === null ? null : `${num('recoveries')} recoveries`,
        num('consecutiveFailures') === null ? null : `${num('consecutiveFailures')} consecutive failures`,
        num('totalFailedCycles') === null ? null : `${num('totalFailedCycles')} failed cycles`);
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'fleet-self-loop-pass': {
      const head = parts(kind, field('runId'),
        num('pass') === null ? null : `pass ${num('pass')}`,
        num('exitCode') === null ? null : `exit ${num('exitCode')}`);
      const detail = parts(field('state'),
        num('consecutiveFailures') === null ? null : `${num('consecutiveFailures')} consecutive failures`,
        num('nextDelayMs') === null ? null : `next in ${num('nextDelayMs')}ms`);
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'reset-watch.start.v1':
      return kind;
    case 'reset-watch.pass.v1':
    case 'reset-watch.end.v1': {
      // pass errors are per-lane hashes and end errors are {lane,message}
      // records: provider text never enters a summary, only the count.
      const errors = record['errors'];
      const errorCount = Array.isArray(errors) ? String(errors.length) : num('errors');
      const healthy = record['healthy'];
      const head = parts(kind,
        healthy === true ? 'healthy' : healthy === false ? 'unhealthy' : field('outcome'),
        num('checked') === null ? null : `${num('checked')} checked`,
        num('passes') === null ? null : `${num('passes')} passes`,
        num('released') === null ? null : `${num('released')} released`);
      const detail = errorCount === null ? null : `${errorCount} errors`;
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'org.membership': {
      const revision = num('revision');
      const needs = record['needs'];
      const head = parts(kind, field('roleId'), field('status'), field('tier'),
        revision === null ? null : `rev ${revision}`);
      const detail = Array.isArray(needs) ? `${needs.length} need${needs.length === 1 ? '' : 's'}` : null;
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'fleet-event': {
      const head = parts(kind, field('event'));
      const detail = parts(field('job'), field('lane'), field('text'));
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'waste-high':
    case 'meter-flat':
    case 'lane-released':
      // Fleet lane/incident notices carry their one-line read in `text`.
      return simple(kind, [], 'text');
    case 'work-board-notify':
      return simple('work-board-notify', ['state'], 'text');
    case 'desktop.intent': {
      const chars = num('chars');
      const head = parts(kind, field('verb'), field('app'));
      const detail = parts(field('window'), chars === null ? null : `${chars} chars`);
      if (head === kind && detail === null) return null;
      return composed(head ?? kind, detail);
    }
    case 'desktopctl': {
      const head = parts('desktopctl', field('phase'), field('action'), field('resource'));
      const detail = pair(field('outcome'), field('detail'));
      if (head === 'desktopctl' && detail === null) return null;
      return composed(head ?? 'desktopctl', detail);
    }
    case 'planner-cycle-result.v1': {
      const head = parts('planner-cycle-result', field('runId'), field('verdict'));
      const execution = record['execution'];
      const ex = execution !== null && typeof execution === 'object' && !Array.isArray(execution)
        ? execution as Record<string, unknown> : null;
      const evidence = record['evidence'];
      const ev = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)
        ? evidence as Record<string, unknown> : null;
      const exitCode = ex === null ? null : summaryNumber(ex, 'exitCode');
      const state = ev === null ? null : summaryField(ev, 'state');
      const detail = parts(
        ex === null ? null : summaryField(ex, 'outcome'),
        ex === null ? null : summaryField(ex, 'provider'),
        exitCode === null ? null : `exit ${exitCode}`,
        state === null ? null : `evidence ${state}`);
      if (head === 'planner-cycle-result' && detail === null) return null;
      return composed(head ?? 'planner-cycle-result', detail);
    }
    case 'fleet.graph-observe.v1': {
      const head = parts('fleet.graph-observe', field('runId'), field('status'));
      const nodes = record['nodes'];
      const detail = Array.isArray(nodes) ? `${nodes.length} node${nodes.length === 1 ? '' : 's'}` : null;
      if (head === 'fleet.graph-observe' && detail === null) return null;
      return composed(head ?? 'fleet.graph-observe', detail);
    }
    case 'guardian-drain.v1': {
      const head = parts('guardian-drain', field('record'), num('sequence'));
      const attempts = num('attempts'), verified = num('verified'), refused = num('refused');
      const detail = parts(field('outcome'), field('termination'),
        attempts === null ? null : `${attempts} attempts`,
        verified === null ? null : `${verified} verified`,
        refused === null ? null : `${refused} refused`);
      if (head === 'guardian-drain' && detail === null) return null;
      return composed(head ?? 'guardian-drain', detail);
    }
    case 'apps-control':
      return simple('apps-control', ['phase', 'action', 'app'], ['outcome', 'detail']);
    default: {
      // `apps-recovery-batch.<stage>.v1` is the one parameterized kind on the bus.
      if (kind.startsWith('apps-recovery-batch.')) {
        const stage = kind.split('.')[1] ?? '';
        const count = (value: unknown, noun: string): string | null =>
          Array.isArray(value) ? `${value.length} ${noun}${value.length === 1 ? '' : 's'}` : null;
        const head = parts('apps-recovery-batch', stage === '' ? null : stage, field('batchRunId'));
        return composed(head ?? 'apps-recovery-batch',
          parts(count(record['invocationIds'], 'invocation'), count(record['verdicts'], 'verdict'), field('outcome')));
      }
      return null;
    }
  }
}

/** Raw renders stay bounded so one large unknown body cannot fill a frame or digest. */
const BUS_BODY_FALLBACK_MAX = 512;

const busFallbackClip = (text: string): string =>
  text.length > BUS_BODY_FALLBACK_MAX ? `${text.slice(0, BUS_BODY_FALLBACK_MAX - 1)}…` : text;

/**
 * Secret-scrubbed, bounded read of a body `busBodySummary` does not know:
 * string bodies render as their text, anything else as raw JSON — both
 * single-line and clipped to 512 characters. The one fallback the inbox
 * frame and the per-agent work digest share.
 */
export function busBodyFallbackSummary(body: unknown): string {
  if (typeof body === 'string') return busFallbackClip(busSummaryField(body));
  return busFallbackClip(scrubSecrets(JSON.stringify(body) ?? 'null'));
}

interface Addressing { identity: AgentIdentity; labels: Set<string>; channels: Map<string, string> }

function addressing(reg: AgentRegistry, ref: string): Addressing | undefined {
  const identity = resolveAgent(reg, ref);
  if (!identity) return undefined;
  const channels = new Map<string, string>();
  for (const channel of reg.channels) if (channel.members.includes(identity.handle)) channels.set(`group:${channel.name}:`, channel.name);
  return { identity, labels: new Set(agentLabels(identity)), channels };
}

function channelOf(to: string, channels: Map<string, string>): string | null {
  for (const [prefix, name] of channels) if (to.startsWith(prefix)) return name;
  return null;
}

/**
 * One already-read registry bound into the label→identity-key lookup the
 * sender filters share: a label resolves to its identity's stable id through
 * handle, `agent:` address, id or alias (exact match first, then lowercase).
 */
function labelIdentityOf(registry: AgentRegistry): AgentIdentityKeyFor {
  const resolved = new Map<string, string | undefined>();
  return (label) => {
    if (!resolved.has(label)) {
      resolved.set(label, (resolveAgent(registry, label) ?? resolveAgent(registry, label.toLowerCase()))?.id);
    }
    return resolved.get(label);
  };
}

/**
 * One page of an identity's inbox: DMs and handoffs to `agent:<handle>`,
 * traffic still addressed to its bare handle, stable id or legacy aliases,
 * and posts in its channels (minus its own and minus `group.presence`
 * heartbeats, which are observations with their own read, never mail).
 * A handoff is the `channel:'handoff'` stamp or the receivable
 * `worker-handoff` body — `fleet handoff-send` posts the body on a legacy
 * envelope — under any of those addresses, so an unstamped or
 * channel-addressed assignment never reads as plain mail.
 * `thread` narrows the page to
 * `note`/`context` bodies carrying that v2 thread label; `from` narrows by
 * sender through the same identity-label matching `channel read` uses — a
 * ref that resolves through the registry matches every label of that
 * identity, an unresolvable ref keeps exact-label matching. `priority` keeps
 * only envelopes stamped with that exact P0..P3 band — the same match
 * `comms bus read --priority` applies — so urgent mail is one filtered read,
 * not a page through the backlog. Returned highest
 * priority first; `nextCursor` covers every scanned row, so callers persist
 * it only after handling the page. Claimable work and worker-handoff items
 * additionally carry `held`/`holder` — the same hold evidence `bus show`
 * reports — so an agent paging mail sees whether pending work is already
 * taken without a lookup per message. `page.matched` asks for the true
 * pending total: the scan then covers the whole retained store instead of
 * stopping at `limit`, counting every row the same filters accept while
 * `messages` still returns only the first `limit` of them.
 */
export function readAgentInbox(ref: string, page: { after?: number; limit?: number; thread?: string; from?: string;
    matched?: boolean; priority?: BusPriority } = {},
  options: UnifiedBusOptions = {}): InboxPage {
  const after = page.after ?? 0, limit = page.limit ?? 50, thread = page.thread, priority = page.priority;
  const countMatched = page.matched === true;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) {
    return { status: 'invalid', reason: 'after must be >= 0 and limit 1-100.' };
  }
  if (thread !== undefined && (typeof thread !== 'string' || !THREAD.test(thread))) {
    return { status: 'invalid', reason: 'Invalid thread label.' };
  }
  if (page.from !== undefined && (typeof page.from !== 'string' || page.from.length === 0 || page.from.length > 128)) {
    return { status: 'invalid', reason: 'Invalid sender filter.' };
  }
  if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) {
    return { status: 'invalid', reason: 'Invalid priority.' };
  }
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const self = `${AGENT_ADDRESS_PREFIX}${target.identity.handle}`;
  const fromMatch = page.from === undefined ? undefined : agentAddressMatcher(labelIdentityOf(read.registry), page.from);
  const messages: InboxMessage[] = [];
  let matched = 0;
  let cursor = after;
  scan: for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: options.now, includeOriginalEnvelope: true });
    if (result.status !== 'ok') {
      return { status: result.status === 'retryable' ? 'retryable' : result.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    let ownerReceipts: OwnerChatReceipt[] | undefined;
    for (const row of result.messages) {
      const envelope = row.envelope;
      // A presence heartbeat is an observation, not mail of any kind.
      if (isGroupPresenceBody(envelope.body)) continue;
      let kind: InboxKind | null = null;
      const channel = channelOf(envelope.to, target.channels);
      // A handoff reaches the wire two ways: `agents bus handoff` stamps
      // `channel:'handoff'`, while `fleet handoff-send` posts the same
      // receivable `worker-handoff` body on a legacy envelope. Either signal
      // marks the kind, addressed to any of the agent's labels or to a member
      // channel's group address from anyone else — the same coverage
      // `work mine` handoffs and `handoff-receive` apply.
      const isHandoff = envelope.channel === 'handoff' || isWorkerHandoffBody(envelope.body);
      const toLabel = target.labels.has(envelope.to);
      const toChannel = channel !== null && !target.labels.has(envelope.from);
      if (isHandoff && (toLabel || toChannel)) kind = 'handoff';
      else if (envelope.to === self) kind = 'dm';
      else if (toLabel) kind = 'legacy';
      else if (toChannel) kind = 'channel';
      const matchedKind = kind !== null &&
        (thread === undefined || busBodyThread(envelope.body) === thread) &&
        (fromMatch === undefined || fromMatch(envelope.from)) &&
        (priority === undefined || envelope.priority === priority) ? kind : null;
      if (matchedKind !== null && envelope.origin_bridge === 'agent-chat-owner') {
        try { ownerReceipts ??= readOwnerChatReceipts(ownerChatRoot(options.root)); }
        catch { return { status: 'unavailable', reason: 'Owner share receipts unavailable.' }; }
        const receiptState = ownerChatReceiptState(row.originalEnvelope ?? envelope, row.cursor, ownerReceipts, target.identity.id);
        if (receiptState === 'pending') return { status: 'retryable', reason: 'Owner share receipt pending.' };
        if (receiptState !== 'accepted') continue;
      }
      if (matchedKind !== null) {
        matched += 1;
        if (!countMatched || messages.length < limit) {
          messages.push({ cursor: row.cursor, receivedAt: row.receivedAt, kind: matchedKind, priority: envelope.priority,
            fromAgent: resolveAgent(read.registry, envelope.from)?.handle ?? null,
            channel: matchedKind === 'channel' ? channel : null, envelope });
        }
      }
      if (!countMatched && messages.length === limit) { cursor = row.cursor; break scan; }
    }
    if (result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  messages.sort((a, b) => a.priority.localeCompare(b.priority) || a.cursor - b.cursor);
  // Claimable work and worker handoffs carry the same hold evidence `bus
  // show` reports; the hold stores are read once for the page, and only
  // when a candidate is present.
  const heldCandidates = messages.filter(m => isClaimableWork(m.envelope.body) || isWorkerHandoffBody(m.envelope.body));
  if (heldCandidates.length > 0) {
    const stores = readHoldStores(options);
    for (const message of heldCandidates) {
      const hold = holdForReceipt({ id: message.envelope.id, cursor: message.cursor,
        receivedAt: message.receivedAt, envelope: message.envelope }, stores);
      message.held = hold.held;
      message.holder = hold.holder;
    }
  }
  return { status: 'ok', agent: target.identity.handle, messages, nextCursor: cursor,
    ...(countMatched ? { matched } : {}) };
}

/** `wh-…` ids are claim-holder hints: a hash of the status envelope and holder, never an envelope id of their own. */
const CLAIM_HOLDER_WAKE_ID = /^wh-[a-f0-9]{32}$/;

/**
 * What a claim-holder hint resolves to on read. The object names the live
 * terminal `work.status` receipt that generated the hint — `statusId` is its
 * wire id, so `agents bus show <statusId>` reads the evidence behind the
 * wake. `'unresolved'` means no live status receipt reproduces the hint (its
 * envelope expired or the hint did not come from this fan-out);
 * `'unknown'` means the bus store could not be read, so resolution was never
 * possible — never reported as "no status".
 */
export type AgentWakeClaimHolder =
  | { statusId: string; jobId: string; status: WorkJob['status']; detail?: string }
  | 'unresolved'
  | 'unknown';

/** A wake-queue row plus, on claim-holder hints only, the status receipt the hint cites. */
export type AgentWakeRow = BusWakeRow & { claimHolder?: AgentWakeClaimHolder };

/**
 * Re-derive which terminal `work.status` receipt generated each `wh-…` hint
 * in the page. The fan-out hashes (status envelope id, holder label) and the
 * hint's own `to` is that label, so re-hashing every live terminal status
 * receipt reproduces the citation with no side journal. Only claim-holder-shaped ids
 * are attempted; every other hint passes through untouched. An unreadable bus
 * store marks them `'unknown'`; a readable one with no reproducing receipt
 * marks them `'unresolved'`.
 */
function claimHolderWakeContexts(rows: readonly BusWakeRow[], options: UnifiedBusOptions): Map<string, AgentWakeClaimHolder> {
  const hints = new Map<string, BusWakeRow>();
  for (const row of rows) if (CLAIM_HOLDER_WAKE_ID.test(row.id)) hints.set(row.id, row);
  const contexts = new Map<string, AgentWakeClaimHolder>();
  if (hints.size === 0) return contexts;
  const scan = scanBusInbox({ root: options.root, now: options.now });
  if (scan.source === 'unavailable') {
    for (const id of hints.keys()) contexts.set(id, 'unknown');
    return contexts;
  }
  const owners = [...new Set([...hints.values()].map(row => row.to))];
  for (const receipt of scan.rows) {
    if (contexts.size === hints.size) break;
    const body: unknown = receipt.envelope.body;
    if (body === null || typeof body !== 'object' || (body as { kind?: unknown }).kind !== 'work.status') continue;
    const parsed = workStatusBodySchema.safeParse(body);
    if (!parsed.success || !WORK_TERMINAL_STATUSES.has(parsed.data.status)) continue;
    for (const owner of owners) {
      const id = claimHolderWakeId(receipt.envelope.id, owner);
      if (!hints.has(id) || contexts.has(id)) continue;
      contexts.set(id, { statusId: receipt.envelope.id, jobId: parsed.data.jobId,
        status: parsed.data.status, ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }) });
    }
  }
  for (const id of hints.keys()) if (!contexts.has(id)) contexts.set(id, 'unresolved');
  return contexts;
}

/** Human suffix naming the status receipt behind a claim-holder hint; '' on ordinary wakes. */
export function agentWakeClaimHolderSuffix(wake: AgentWakeRow): string {
  const holder = wake.claimHolder;
  if (holder === undefined) return '';
  if (holder === 'unknown') return ' claim-holder=unknown';
  if (holder === 'unresolved') return ' claim-holder=unresolved';
  return ` claim-holder job=${holder.jobId} status=${holder.status} receipt=${holder.statusId}`;
}

export type WakePage = { status: 'ok'; agent: string; wakes: AgentWakeRow[];
  /** Every hint the bounded queue read matched for the agent, before its row cap; `wakes` shows only the newest slice. */
  matched: number;
  /** The queue tail or row cap cut matches beyond `wakes`; false only when the bounded read provably saw them all. */
  truncated: boolean } |
  { status: 'unknown-agent' | 'unavailable'; reason: string };

/**
 * Wake hints addressed to this identity under any label it resolves through
 * (address, bare handle, stable id or alias) or to one of its channels after
 * `sinceAt`. A wake is only a hint to read the inbox: it carries routing ids,
 * never a body, and grants nothing. Claim-holder hints (`wh-…` ids) carry no
 * envelope id of their own, so each is re-resolved against the live
 * `work.status` receipts that could have generated it and annotated with the
 * citing status — `unresolved` when none reproduces it, `unknown` when the
 * bus store cannot be read. `matched` counts every hint the bounded
 * queue tail matched before its row cap and `truncated` marks older bytes or
 * matched rows beyond the returned slice — an unreadable queue stays
 * `unavailable`, never an empty page passed off as "no wakes".
 */
export function readAgentWakes(ref: string, sinceAt: number | undefined, options: UnifiedBusOptions = {}): WakePage {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const wakes = readBusWakes({ root: options.runsRoot, sinceAt, match: wake =>
    target.labels.has(wake.to) || (channelOf(wake.to, target.channels) !== null && !target.labels.has(wake.from)) });
  if (wakes.state === 'unreadable') return { status: 'unavailable', reason: 'Wake queue is unreadable.' };
  const contexts = claimHolderWakeContexts(wakes.wakes, options);
  return { status: 'ok', agent: target.identity.handle,
    wakes: wakes.wakes.map(row => {
      const claimHolder = contexts.get(row.id);
      return claimHolder === undefined ? row : { ...row, claimHolder };
    }),
    matched: wakes.matched ?? 0, truncated: wakes.truncated ?? false };
}

export interface ChannelListEntry {
  name: string;
  createdBy: string;
  createdAt: number;
  /** Member handles in join order; routing labels, not authenticated principals. */
  members: string[];
}
export type ChannelList =
  | { status: 'ok'; source: 'missing' | 'available'; agent: string | null; channels: ChannelListEntry[] } |
  { status: 'unknown-agent' | 'unavailable'; reason: string };

/**
 * Channel discovery for the unified bus: every registry channel, or only the
 * channels one resolved identity belongs to. A missing registry is a
 * verified-empty list (`source: 'missing'`), never an error; an unreadable one
 * is `unavailable`, not empty. Membership says who may post — it is not proof
 * of presence, attention or authority.
 */
export function listBusChannels(agent: string | undefined, options: UnifiedBusOptions = {}): ChannelList {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  let handle: string | null = null;
  if (agent !== undefined) {
    const identity = resolveAgent(read.registry, agent);
    if (!identity) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
    handle = identity.handle;
  }
  const channels = read.registry.channels
    .filter(channel => handle === null || channel.members.includes(handle))
    .map(channel => ({ name: channel.name, createdBy: channel.createdBy, createdAt: channel.createdAt,
      members: [...channel.members] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { status: 'ok', source: read.source, agent: handle, channels };
}

export interface ChannelReadMessage {
  cursor: number;
  receivedAt: number;
  priority: BusPriority;
  /** Topic component of the `group:<channel>:<topic>` address the post was sent to. */
  topic: string;
  /** Registered handle of the sender label, or null. A label is never authentication. */
  fromAgent: string | null;
  envelope: BusEnvelope;
}
export interface ChannelReadOptions {
  /** Restrict the page to one topic; default every topic of the channel. */
  topic?: string;
  /**
   * Sender filter: a handle, `agent:<handle>`, stable id or alias. A ref that
   * resolves through the identity registry matches every label of that
   * identity; an unresolvable ref keeps exact-label matching.
   */
  from?: string;
  /**
   * Thread filter: the v2 `thread` label a `note`/`context` body carries.
   * Every other body kind — and a note without the field — never matches.
   */
  thread?: string;
  /**
   * Priority filter: only posts stamped with this exact P0..P3 band — the
   * same match `comms bus read --priority` applies.
   */
  priority?: BusPriority;
  after?: number;
  limit?: number;
}
export type ChannelReadPage =
  | { status: 'ok'; channel: string; messages: ChannelReadMessage[]; nextCursor: number }
  | { status: 'invalid' | 'unknown-channel' | 'unavailable' | 'retryable'; reason: string };

/**
 * One page of a channel's posts, oldest first: every live envelope addressed
 * to `group:<name>:*` — or to one `topic` — except `group.presence`
 * heartbeats, which are expiring observations with their own read
 * (`groupPresence`), not messages. Reading needs no identity and no
 * membership: membership gates posting only, and the rows are the same
 * shared store `comms bus group read` sees. `from` narrows by sender through
 * the same identity-label matching `comms bus read` uses; `thread` narrows to
 * `note`/`context` bodies carrying that v2 thread label, and `priority`
 * narrows to posts stamped with that exact P0..P3 band. `nextCursor`
 * covers every scanned row, so callers persist it only after handling the
 * page; a missing registry means no channel exists, an unreadable one or an
 * unreadable store is reported, never an empty page passed off as history.
 */
export function readAgentChannel(name: string, page: ChannelReadOptions = {}, options: UnifiedBusOptions = {}): ChannelReadPage {
  const after = page.after ?? 0, limit = page.limit ?? 50, thread = page.thread, priority = page.priority;
  if (typeof name !== 'string' || !agentChannelNameSchema.safeParse(name).success) {
    return { status: 'invalid', reason: 'Invalid channel name.' };
  }
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) {
    return { status: 'invalid', reason: 'after must be >= 0 and limit 1-100.' };
  }
  if (thread !== undefined && (typeof thread !== 'string' || !THREAD.test(thread))) {
    return { status: 'invalid', reason: 'Invalid thread label.' };
  }
  if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) {
    return { status: 'invalid', reason: 'Invalid priority.' };
  }
  let exact: string | undefined;
  if (page.topic !== undefined) {
    if (typeof page.topic !== 'string') return { status: 'invalid', reason: 'Invalid channel topic.' };
    try { exact = groupAddress(name, page.topic); }
    catch { return { status: 'invalid', reason: 'Invalid channel topic.' }; }
  }
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  if (!findAgentChannel(read.registry, name)) return { status: 'unknown-channel', reason: 'Channel does not exist.' };
  const prefix = `group:${name}:`;
  let fromMatch: ((value: string) => boolean) | undefined;
  if (page.from !== undefined) {
    if (typeof page.from !== 'string' || page.from.length === 0 || page.from.length > 128) {
      return { status: 'invalid', reason: 'Invalid sender filter.' };
    }
    fromMatch = agentAddressMatcher(labelIdentityOf(read.registry), page.from);
  }
  const messages: ChannelReadMessage[] = [];
  let cursor = after;
  scan: for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: options.now });
    if (result.status !== 'ok') {
      return { status: result.status === 'retryable' ? 'retryable' : result.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    for (const row of result.messages) {
      const envelope = row.envelope, body = envelope.body;
      const presence = isGroupPresenceBody(body);
      if (!presence && envelope.to.startsWith(prefix) && (exact === undefined || envelope.to === exact) &&
          (fromMatch === undefined || fromMatch(envelope.from)) &&
          (thread === undefined || busBodyThread(body) === thread) &&
          (priority === undefined || envelope.priority === priority)) {
        messages.push({ cursor: row.cursor, receivedAt: row.receivedAt, priority: envelope.priority,
          topic: envelope.to.slice(prefix.length),
          fromAgent: resolveAgent(read.registry, envelope.from)?.handle ?? null, envelope });
      }
      if (messages.length === limit) { cursor = row.cursor; break scan; }
    }
    if (result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  return { status: 'ok', channel: name, messages, nextCursor: cursor };
}

export interface BusEnvelopeLookupMessage {
  cursor: number;
  receivedAt: number;
  /**
   * Registered handle of the sender label, or null. A label is never
   * authentication; null also covers an unreadable registry — the raw
   * `envelope.from` label is always present either way.
   */
  fromAgent: string | null;
  /** Live receipt: `ttl` here is the remaining TTL at read time. */
  envelope: BusEnvelope;
}
export type BusEnvelopeLookup =
  | { status: 'ok'; id: string; message: BusEnvelopeLookupMessage;
      /**
       * Present only when the body is claimable work or a worker handoff:
       * whether a taken message-id claim or a live coordination hold provably
       * covers the envelope — the same rule `work mine` next/handoffs and the
       * unified comms inbox apply. `held` false is proof of free; null means
       * a hold store could not be read (unknown, never proven free).
       */
      held?: boolean | null;
      /** Owner label of the blocking claim when held and known; null otherwise. */
      holder?: string | null }
  | { status: 'not-found'; id: string }
  | { status: 'invalid' | 'unavailable' | 'retryable'; reason: string };

/**
 * The two hold stores read once per lookup or inbox page. 'unavailable'
 * marks a store that cannot be read — coverage is then unknown, never
 * proven free.
 */
type HoldStores = 'unavailable' | {
  claims: ReturnType<typeof inspectBusWorkClaims>['claims'];
  coordination: ReturnType<typeof listCoordination>['claims'];
  now: number;
};

function readHoldStores(options: UnifiedBusOptions): HoldStores {
  const now = (options.now ?? Date.now)();
  const claimsRead = inspectBusWorkClaims(options.root);
  const coordination = listCoordination(options.root, now);
  if (claimsRead.source === 'unavailable' || coordination.source === 'unavailable') return 'unavailable';
  return { claims: claimsRead.claims, coordination: coordination.claims, now };
}

/**
 * Hold state for one resolved receipt against already-read stores: a
 * message-id claim row matching the exact `(id, cursor, receivedAt)` receipt
 * triple (a completed row stays taken, an expired lease does not) or a live
 * coordination row blocking `queue:<id>`.
 */
function holdForReceipt(receipt: { id: string; cursor: number; receivedAt: number; envelope: BusEnvelope },
  stores: HoldStores): { held: boolean | null; holder: string | null } {
  if (stores === 'unavailable') return { held: null, holder: null };
  const messageOwner = stores.claims.find(row =>
    row.id === receipt.envelope.id && row.cursor === receipt.cursor && row.receivedAt === receipt.receivedAt &&
    (row.completedAt !== null || row.leaseUntil > stores.now))?.owner;
  const coordinationBlocker = stores.coordination.find(row => row.live &&
    coordinationRowBlocks(row, `queue:${receipt.envelope.id}`));
  const held = messageOwner !== undefined || coordinationBlocker !== undefined;
  return { held, holder: held ? messageOwner ?? coordinationBlocker?.owner ?? null : null };
}

/**
 * Hold state for one resolved envelope, for the claimable kinds only. A
 * store that cannot be read makes the answer unknown — never reported free.
 */
function envelopeHold(receipt: { id: string; cursor: number; receivedAt: number; envelope: BusEnvelope },
  options: UnifiedBusOptions): { held: boolean | null; holder: string | null } | undefined {
  const body = receipt.envelope.body;
  if (!isClaimableWork(body) && !isWorkerHandoffBody(body)) return undefined;
  return holdForReceipt(receipt, readHoldStores(options));
}

/**
 * Resolve one retained envelope by its wire id — the key wake hints, claim
 * operations, `work mine` items and dedupe all cite. The scan is the same
 * bounded page walk the other reads use and sees only live (unexpired)
 * receipts: an expired or reclaimed-away id reports `not-found`, never a
 * stale row. Reading needs no identity and no addressing scope: like
 * `readAgentChannel`, the store is shared and ids are routing data, not
 * secrets. `fromAgent` decoration is best-effort; an unreadable registry
 * never hides the envelope itself. Claimable work and worker-handoff bodies
 * additionally report `held`/`holder` — whether a taken claim or live
 * coordination hold already covers the envelope, the same evidence `work
 * mine` next/handoffs and the unified comms inbox show.
 */
export function readBusEnvelopeById(id: string, options: UnifiedBusOptions = {}): BusEnvelopeLookup {
  if (typeof id !== 'string' || !THREAD.test(id)) {
    return { status: 'invalid', reason: 'Invalid message id.' };
  }
  const registry = readAgentRegistry(options);
  let cursor = 0;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: options.now });
    if (result.status !== 'ok') {
      return { status: result.status === 'retryable' ? 'retryable' : result.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    for (const row of result.messages) {
      if (row.envelope.id === id) {
        const message: BusEnvelopeLookupMessage = { cursor: row.cursor, receivedAt: row.receivedAt,
          fromAgent: registry.status === 'ok' ? resolveAgent(registry.registry, row.envelope.from)?.handle ?? null : null,
          envelope: row.envelope };
        const hold = envelopeHold({ id: row.envelope.id, cursor: row.cursor, receivedAt: row.receivedAt,
          envelope: row.envelope }, options);
        return { status: 'ok', id, message, ...(hold ?? {}) };
      }
    }
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  return { status: 'not-found', id };
}
