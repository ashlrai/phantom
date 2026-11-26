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
  type BusInboxOptions, type BusInboxPost, type BusInboxReceipt, type BusInboxScan } from '../fleet/bus-inbox.js';
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
import { coordinationRowBlocks, listCoordination, setWorkStatus } from './claim-store.js';
import { BUS_V2_TEXT_MAX, WORK_RESULT_OUTCOMES, busBodyKind, busBodyResultOutcome, busBodyThread, contextBodySchema,
  noteBodySchema, wakeBodySchema, workPostBodySchema, workStatusBodySchema,
  type Participant, type WorkJob, type WorkResultOutcome } from './bus-v2-schema.js';
import { readBusWorkFeed, runtimeProvider, type BusWorkFeedJob, type BusWorkFeedReadResult } from './bus-work-feed-read.js';
import {
  AGENT_ADDRESS_PREFIX, agentChannelNameSchema, agentLabels, agentRefAddressMatcher, findAgentChannel, readAgentRegistry,
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
      claimHoldersWoken?: number | null;
      /**
       * `work.status` only, and only on a newly-posted envelope: whether the
       * job's latest status was recorded in the shared coordination
       * `statuses` table — true when the row was written, false on a
       * definitive refusal (store full), null when the store could not be
       * read or written (unknown). Absent on a duplicate post, which adds no
       * cursor so the recorded status must not be overwritten stale. The
       * announce verb does not record: `queued` is already the feed's
       * projection of `work.post`, and a locked coordination write on every
       * announcement is too costly for a state the feed already shows.
       */
      statusRecorded?: boolean | null }
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
export interface DirectMessageInput extends SendCommon {
  to: string;
  text: string;
  /** v2 conversational body kind; default `note`. */
  kind?: 'note' | 'context';
  thread?: string;
  refs?: string[];
  replyTo?: string;
}
export interface ChannelPostInput extends SendCommon {
  channel: string;
  topic?: string;
  text: string;
  /** v2 conversational body kind; default `note`. */
  kind?: 'note' | 'context';
  thread?: string;
  refs?: string[];
  replyTo?: string;
}
export interface LabelPostInput extends SendCommon {
  /** Plain routing label the message addresses; the reserved prefixes are refused. */
  to: string;
  text: string;
  /** v2 conversational body kind; default `note`. */
  kind?: 'note' | 'context';
  thread?: string;
  refs?: string[];
  replyTo?: string;
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

function noteBody(input: { kind?: 'note' | 'context'; text: string; thread?: string; refs?: string[]; replyTo?: string }) {
  return {
    kind: input.kind ?? 'note', text: input.text,
    ...(input.thread === undefined ? {} : { thread: input.thread }),
    ...(input.refs === undefined ? {} : { refs: input.refs }),
    ...(input.replyTo === undefined ? {} : { inReplyTo: input.replyTo }),
  };
}

function noteFields(input: { kind?: unknown; text: unknown; thread?: unknown; refs?: unknown; replyTo?: unknown }): string | null {
  if (input.kind !== undefined && input.kind !== 'note' && input.kind !== 'context') return 'Kind must be note or context.';
  if (!text(input.text)) return `Text must be 1-${BUS_V2_TEXT_MAX} characters.`;
  if (input.thread !== undefined && (typeof input.thread !== 'string' || !THREAD.test(input.thread))) return 'Thread must be a printable label.';
  if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 32 ||
    input.refs.some(ref => typeof ref !== 'string' || ref.length < 1 || ref.length > 256))) return 'Refs must be up to 32 short strings.';
  if (input.replyTo !== undefined && (typeof input.replyTo !== 'string' || !THREAD.test(input.replyTo))) {
    return 'Reply target must be a printable message id.';
  }
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
 * Record one job's latest status in the shared coordination `statuses`
 * table — the durable per-job status rows `claimBoard` returns and
 * `agents bus status` counts beside live claims, the registry that survives
 * feed retention. Best-effort like the claim-holder fan-out: a store fault
 * reports null (unknown) and never fails the posted message. Call only for
 * a newly-posted envelope — a duplicate adds no cursor, so the feed's
 * newest status may already differ and must not be overwritten with a stale
 * value. Returns true when the row was written, false on a definitive
 * refusal (the store is full), null when the outcome is unknown.
 */
function recordCoordinationWorkStatus(input: {
  jobId: string; owner: string; provider: string; repo: string;
  claimKeys: readonly string[]; status: string;
}, options: UnifiedBusOptions): boolean | null {
  try {
    const result = setWorkStatus({ root: options.root, jobId: input.jobId, owner: input.owner,
      provider: input.provider, repo: input.repo, claimKeys: [...input.claimKeys], status: input.status,
      updatedAt: (options.now ?? Date.now)() });
    if (result.status === 'acquired') return true;
    return result.status === 'unavailable' ? null : false;
  } catch { return null; }
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
  if (sent.status !== 'posted' && sent.status !== 'duplicate') return sent;
  // Record the job's latest status in the coordination `statuses` table — the
  // durable per-job registry `claimBoard` and `agents bus status` report —
  // only for a newly-posted envelope, so a duplicate never overwrites a newer
  // feed status with a stale one. Best-effort: a store fault reports null and
  // never fails the posted send.
  const statusRecorded = sent.status === 'posted'
    ? recordCoordinationWorkStatus({ jobId: job.id, owner: job.owner, provider: job.provider,
        repo: job.repo, claimKeys: job.claimKeys, status: body.data.status }, options)
    : undefined;
  const recorded = statusRecorded === undefined ? {} : { statusRecorded };
  // A terminal status also hints every live claim holder on the job's keys;
  // --no-wake opts out of that fan-out as well as the message's own hint. A
  // fan-out fault leaves holder state unknown — it never fails the posted send.
  // The fan-out runs for a reposted status too: the deduped hint ids keep it
  // idempotent, exactly like the envelope dedupe keeps the feed unchanged.
  if (input.wake === false || !WORK_TERMINAL_STATUSES.has(body.data.status)) return { ...sent, ...recorded };
  let claimHoldersWoken: number | null;
  try {
    claimHoldersWoken = signalWorkClaimHolders(job, sender, reg, sent.id, options);
  } catch {
    claimHoldersWoken = null;
  }
  return { ...sent, claimHoldersWoken, ...recorded };
}

export type InboxKind = 'dm' | 'channel' | 'handoff' | 'legacy';
export const INBOX_KINDS: readonly InboxKind[] = ['dm', 'channel', 'handoff', 'legacy'];
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
  /**
   * Bodies that name a job — `work.post`, `work.status`, `work.result` and
   * `wake` declaring a `jobId`, or a `worker-handoff` assigning its fleet
   * job id through `taskId`: the live work-feed state of the job the body
   * cites — the same `BusEnvelopeLookupJob` `bus show` resolves, computed
   * with one feed read per page so an agent paging mail sees where each
   * announced job stands without a lookup per message. Absent on every
   * other body kind.
   */
  job?: BusEnvelopeLookupJob;
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

/** Longest `--contains` needle the bus reads accept; the summaries it matches are already bounded far shorter. */
export const BUS_READ_CONTAINS_MAX = 512;

/**
 * The `--contains` text search every bus read shares: a case-insensitive
 * substring over the same scrubbed one-line summary the inbox frame and
 * `show` surfaces render for the row — `busBodySummary` for typed bodies,
 * the bounded scrubbed JSON fallback otherwise — with whitespace collapsed
 * on both sides so a phrase typed across a line break still finds its
 * message. Matching the rendered summary, never the raw body, keeps a
 * secret-shaped value unfindable even though it sits in the stored
 * envelope, and a match is always visible in the row it selects — the same
 * guarantee `phm messages --contains` gives the timeline projection.
 * `agents bus inbox`, `agents bus channel read`, `comms bus read`/`watch`
 * and `fleet bus-follow` apply this one rule, so a `--contains` read can
 * never disagree about what names a match; protocol-v1 payloads stay opaque
 * to the summary, so payload text is not searchable on any surface.
 * `needle` arrives already normalized by `busReadContainsNeedle`.
 */
export function busReadContainsMatch(body: unknown, needle: string): boolean {
  return (busBodySummary(body) ?? busBodyFallbackSummary(body))
    .toLowerCase().replace(/\s+/g, ' ').includes(needle);
}

/** The normalized form of a validated `--contains` value: lowercase, whitespace collapsed, trimmed. */
function busReadContainsNeedle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * `--contains` validation shared by every bus read: bounded non-blank free
 * text, not a label — printable content of any kind is fine. Answers the
 * normalized needle, or undefined when the filter is absent; callers report
 * `invalid` on the `null` sentinel.
 */
export function busReadContains(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > BUS_READ_CONTAINS_MAX) return null;
  return busReadContainsNeedle(value);
}

/**
 * The honest resume cursor a paged bus read reports. A plain page stops the
 * scan at `limit`, so its `nextCursor` already resumes strictly before the
 * first unshown row. A `matched` page scans the whole retained store to count
 * every accepted row, so its raw `nextCursor` is the store's end — resuming
 * there would skip every match beyond the shown slice. When `matched`
 * exceeds the shown rows the resume point is the newest shown row's cursor:
 * every unshown match sits beyond it and every shown one at or before it, so
 * `--after <nextCursor>` continues the page without a gap or a repeat. A
 * `matched` total that fits inside the page keeps the store-end cursor —
 * nothing was hidden, so the scan's end is the honest resume. The CLI and
 * the fleet MCP adapters all report this one cursor, so a matched read can
 * never disagree about where to resume.
 */
export function busPageResumeCursor(page: { nextCursor: number; matched?: number;
    messages: readonly { cursor: number }[] }): number {
  return page.matched !== undefined && page.matched > page.messages.length && page.messages.length > 0
    ? Math.max(...page.messages.map(message => message.cursor))
    : page.nextCursor;
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
export function labelIdentityOf(registry: AgentRegistry): AgentIdentityKeyFor {
  const resolved = new Map<string, string | undefined>();
  return (label) => {
    if (!resolved.has(label)) {
      resolved.set(label, (resolveAgent(registry, label) ?? resolveAgent(registry, label.toLowerCase()))?.id);
    }
    return resolved.get(label);
  };
}

/**
 * The job-scoped bus filter every read surface shares: mail that names one
 * job — a feed-citing body (`work.post`, `work.status`, `work.result` or
 * `wake`) declaring that `jobId` through the same field the feed projection
 * keys on, a `worker-handoff` assigning that fleet job id through `taskId`,
 * or a `note`/`context` body carrying the `job:<id>` v2 thread label, the
 * same bucket the messages and conversations projections group under
 * `job:<id>`. Every other body kind cites no job and never matches; a bare
 * `<id>` thread label is a different conversation bucket and does not match
 * either. `agents bus inbox`/`channel read`, `comms bus read`/`watch` and
 * `fleet bus-follow` apply this one rule for their `job` filters, so a
 * job-scoped read can never disagree about what names a job; the citation
 * half (`busBodyJobId`) is the same field the message, channel, inbox and
 * work-mine annotations key on.
 */
export function busBodyJobMatch(body: unknown, job: string): boolean {
  return busBodyJobId(body) === job || busBodyThread(body) === `job:${job}`;
}

/**
 * The reply-citation match every bus read's `inReplyTo` filter applies: an
 * object body whose own `inReplyTo` field is strictly equal to the cited
 * envelope id — exact and case-sensitive, never the `replyTo` alias or a
 * substring, and never a non-object or array body. This is the one rule
 * `phm messages --in-reply-to`, `comms bus read|watch --in-reply-to`,
 * `fleet bus-follow --in-reply-to`, `fleet_bus_inbox`'s `inReplyTo`,
 * `agents bus inbox --in-reply-to` and `agents bus channel read
 * --in-reply-to` share, so "who answered envelope X" can never disagree
 * about what counts as the answer; the citation is an application
 * convention on the body, not an envelope field or authenticated identity.
 */
export function busBodyInReplyToMatch(body: unknown, inReplyTo: string): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.hasOwn(record, 'inReplyTo') && record['inReplyTo'] === inReplyTo;
}

/**
 * One page of an identity's inbox: DMs and handoffs to `agent:<handle>`,
 * traffic still addressed to any label that resolves to its identity — the
 * bare handle, stable id or legacy aliases, exact first then lowercase, the
 * same addressed-to fold `bus next`, `work mine`, `handoff-receive` and the
 * conversations reads apply — and posts in its channels (minus its own and
 * minus `group.presence` heartbeats, which are observations with their own
 * read, never mail).
 * A handoff is the `channel:'handoff'` stamp or the receivable
 * `worker-handoff` body — `fleet handoff-send` posts the body on a legacy
 * envelope — under any of those addresses, so an unstamped or
 * channel-addressed assignment never reads as plain mail.
 * `thread` narrows the page to
 * `note`/`context` bodies carrying that v2 thread label; `from` narrows by
 * sender through the same identity-label matching `channel read` uses — a
 * ref that resolves through the registry matches every label of that
 * identity, an unresolvable ref keeps exact-label matching. `excludeFrom`
 * drops mail sent under every registered spelling of one identity — the
 * same sender-exclusion rule `comms bus read|watch --exclude-from`,
 * `fleet bus-follow --exclude-from` and `fleet_bus_inbox`'s `excludeFrom`
 * apply — so a member's noisy sender never reaches the page while every
 * other sender still does; it composes with `from` (a sender both included
 * and excluded matches nothing) and with every other filter. `priority` keeps
 * only envelopes stamped with that exact P0..P3 band — the same match
 * `comms bus read --priority` applies — so urgent mail is one filtered read,
 * not a page through the backlog. `job` keeps only mail that names one job:
 * a feed-citing body (`work.post`, `work.status`, `work.result` or `wake`)
 * declaring that `jobId`, a `worker-handoff` assigning that fleet job id
 * through `taskId`, or a `note`/`context` body carrying the
 * `job:<id>` v2 thread label — the same bucket the messages and
 * conversations projections group under `job:<id>`. `since` keeps only mail
 * received at or after that epoch-ms cutoff — the same inclusive
 * `receivedAt >= since` match `phm messages --since` applies, so fresh mail
 * is one filtered read without a persisted cursor. `before` keeps only mail
 * received strictly before that epoch-ms cutoff — the exclusive upper bound
 * every bus read's `--before` applies — composing with `since` into one
 * `[since, before)` window on `receivedAt` so "what was in my inbox before
 * time T" is one filtered read. `channel` keeps only mail
 * addressed to `group:<name>:*` of one registry channel the agent belongs
 * to — channel posts (`kind:'channel'`) and channel-addressed handoffs
 * (`kind:'handoff'`) alike, matched on the delivery address rather than the
 * reported kind, so `--channel` composes with `--kind` to read just one
 * room's direct mail or just its assignments; DMs and label-addressed mail
 * never match, and a channel the agent is not a member of simply has no
 * mail to show. `contains` keeps only mail whose scrubbed one-line
 * summary — the same text the frame renders per row — carries the needle
 * as a case-insensitive substring, so "did anyone send me mail about X"
 * is one filtered read instead of a page through the backlog; matching
 * runs over the rendered summary, never the raw body, so a secret-shaped
 * value stays unfindable even though it sits in the stored envelope.
 * `inReplyTo` keeps only mail whose object body cites that envelope id
 * through its own `inReplyTo` field — the same own-property exact match
 * `phm messages --in-reply-to`, `comms bus read|watch --in-reply-to`,
 * `fleet bus-follow --in-reply-to`, `fleet_bus_inbox`'s `inReplyTo` and
 * `channel read --in-reply-to` apply, never the `replyTo` alias or a
 * substring — so "which of my pending mail answers envelope X" is one
 * filtered read of the addressed inbox, composing with every other
 * filter. `id` keeps only the row whose own wire id is strictly equal to
 * the value — the same exact-envelope match `comms bus read|watch --id`,
 * `fleet bus-follow --id` and `fleet_bus_inbox`'s `id` apply, never a
 * substring — so "is envelope X still pending for me" is one filtered
 * read that composes with every other filter. `bodyKind` keeps only mail
 * whose body carries that exact kind discriminator — the v2 `kind` field,
 * a `worker-handoff` assignment, a notice kind, a bus-transport v1
 * `protocol.kind` or a `type`/`schema` notice discriminator, the same
 * discriminator `busBodySummary` switches on — matched exactly and
 * case-sensitively, so "which of my pending mail are work results" or
 * "which are wake requests" is one filtered read; a body carrying no
 * discriminator never matches. `result` keeps only mail whose body is a
 * `work.result` receipt reporting that one outcome — the same
 * `WORK_RESULT_OUTCOMES` codes the work feed's `--result` filter and
 * `phm messages --result` validate, read through the kind-scoped
 * `busBodyResultOutcome` own-field match — so every other body kind (a
 * `work.release` body's own `released`/`completed` outcome included) and
 * a `work.result` carrying no outcome never matches: "which of my
 * pending result receipts failed" is one filtered read, the
 * envelope-level audit trail the feed's per-job newest-result `--result`
 * cannot show.
 * `with` narrows the page to the two-way exchange the addressed agent and
 * one peer name — the same pairwise rule `phm messages --with` and
 * `agents conversations --with` apply. Every inbox row is already
 * addressed to the agent, so the agent→peer direction never appears and
 * the peer→agent direction keeps only rows the peer's identity labels
 * sent to the agent's own labels: channel posts and channel-addressed
 * handoffs carry a room address, not the peer, and never match — "our
 * private pending thread", not "everything the peer said in the rooms we
 * share". The peer ref resolves through the registry exactly like
 * `from`/`excludeFrom`, so an unresolvable ref keeps exact-label matching
 * and unknown identity state never widens the filter.
 * Returned highest
 * priority first; `nextCursor` covers every scanned row, so callers persist
 * it only after handling the page. Claimable work and worker-handoff items
 * additionally carry `held`/`holder` — the same hold evidence `bus show`
 * reports — so an agent paging mail sees whether pending work is already
 * taken without a lookup per message. Items whose body names a job
 * (`work.post`, `work.status`, `work.result` or `wake` declaring a `jobId`,
 * or a `worker-handoff` assigning its `taskId`) additionally carry
 * `job` — the live feed state of the job they cite,
 * the same `BusEnvelopeLookupJob` `bus show` resolves — read once per page,
 * so a work announcement or status report answers where its job stands
 * (status, claim coverage, or the feed's own refusal) without a `show`
 * per message. `page.matched` asks for the true
 * pending total: the scan then covers the whole retained store instead of
 * stopping at `limit`, counting every row the same filters accept while
 * `messages` still returns only the first `limit` of them.
 */
export function readAgentInbox(ref: string, page: { after?: number; limit?: number; thread?: string; from?: string;
    excludeFrom?: string; with?: string; matched?: boolean; priority?: BusPriority; kind?: InboxKind; job?: string; since?: number;
    before?: number; channel?: string; contains?: string; inReplyTo?: string; id?: string; bodyKind?: string;
    result?: WorkResultOutcome } = {},
  options: UnifiedBusOptions = {}): InboxPage {
  const after = page.after ?? 0, limit = page.limit ?? 50, thread = page.thread, priority = page.priority;
  const countMatched = page.matched === true;
  const kindFilter = page.kind, jobFilter = page.job, since = page.since, before = page.before, channelFilter = page.channel;
  const inReplyTo = page.inReplyTo, idFilter = page.id, bodyKindFilter = page.bodyKind, resultOutcome = page.result;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) {
    return { status: 'invalid', reason: 'after must be >= 0 and limit 1-100.' };
  }
  if (thread !== undefined && (typeof thread !== 'string' || !THREAD.test(thread))) {
    return { status: 'invalid', reason: 'Invalid thread label.' };
  }
  if (page.from !== undefined && (typeof page.from !== 'string' || page.from.length === 0 || page.from.length > 128)) {
    return { status: 'invalid', reason: 'Invalid sender filter.' };
  }
  if (page.excludeFrom !== undefined &&
      (typeof page.excludeFrom !== 'string' || page.excludeFrom.length === 0 || page.excludeFrom.length > 128)) {
    return { status: 'invalid', reason: 'Invalid sender-exclusion filter.' };
  }
  if (page.with !== undefined &&
      (typeof page.with !== 'string' || page.with.length === 0 || page.with.length > 128)) {
    return { status: 'invalid', reason: 'Invalid peer filter.' };
  }
  if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) {
    return { status: 'invalid', reason: 'Invalid priority.' };
  }
  if (kindFilter !== undefined && !INBOX_KINDS.includes(kindFilter)) {
    return { status: 'invalid', reason: 'Invalid kind.' };
  }
  if (jobFilter !== undefined && (typeof jobFilter !== 'string' || !THREAD.test(jobFilter))) {
    return { status: 'invalid', reason: 'Invalid job id.' };
  }
  if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !THREAD.test(inReplyTo))) {
    return { status: 'invalid', reason: 'Invalid in-reply-to id.' };
  }
  if (idFilter !== undefined && (typeof idFilter !== 'string' || !THREAD.test(idFilter))) {
    return { status: 'invalid', reason: 'Invalid message id.' };
  }
  if (bodyKindFilter !== undefined && (typeof bodyKindFilter !== 'string' || !THREAD.test(bodyKindFilter))) {
    return { status: 'invalid', reason: 'Invalid body kind.' };
  }
  if (resultOutcome !== undefined && !(WORK_RESULT_OUTCOMES as readonly string[]).includes(resultOutcome)) {
    return { status: 'invalid', reason: 'Invalid result outcome.' };
  }
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { status: 'invalid', reason: 'Invalid since.' };
  }
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    return { status: 'invalid', reason: 'Invalid before.' };
  }
  if (channelFilter !== undefined && (typeof channelFilter !== 'string' || !agentChannelNameSchema.safeParse(channelFilter).success)) {
    return { status: 'invalid', reason: 'Invalid channel name.' };
  }
  const containsNeedle = busReadContains(page.contains);
  if (containsNeedle === null) {
    return { status: 'invalid', reason: 'Invalid contains filter.' };
  }
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const self = `${AGENT_ADDRESS_PREFIX}${target.identity.handle}`;
  const identityOf = labelIdentityOf(read.registry);
  const fromMatch = page.from === undefined ? undefined : agentRefAddressMatcher(page.from, read.registry, identityOf);
  const excludeFromMatch = page.excludeFrom === undefined ? undefined
    : agentRefAddressMatcher(page.excludeFrom, read.registry, identityOf);
  const withMatch = page.with === undefined ? undefined : agentRefAddressMatcher(page.with, read.registry, identityOf);
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
      // "Addressed to this identity" is the same label resolution every other
      // addressed-to read applies — handle, `agent:` address, stable id or
      // alias, exact first then lowercase — so a case-folded spelling of a
      // registered label reaches the same inbox `bus next`, `work mine`,
      // `handoff-receive` and the conversations reads already count as its
      // pending work; a spelling that resolves to no identity still reaches
      // nobody. The channel self-exclusion stays on the exact stored labels,
      // the same rule `agentPendingAddressMatcher` keeps.
      const toLabel = identityOf(envelope.to) === target.identity.id;
      const toChannel = channel !== null && !target.labels.has(envelope.from);
      if (isHandoff && (toLabel || toChannel)) kind = 'handoff';
      else if (envelope.to === self) kind = 'dm';
      else if (toLabel) kind = 'legacy';
      else if (toChannel) kind = 'channel';
      const matchedKind = kind !== null &&
        (kindFilter === undefined || kind === kindFilter) &&
        (idFilter === undefined || envelope.id === idFilter) &&
        (thread === undefined || busBodyThread(envelope.body) === thread) &&
        (jobFilter === undefined || busBodyJobMatch(envelope.body, jobFilter)) &&
        (inReplyTo === undefined || busBodyInReplyToMatch(envelope.body, inReplyTo)) &&
        (fromMatch === undefined || fromMatch(envelope.from)) &&
        (excludeFromMatch === undefined || !excludeFromMatch(envelope.from)) &&
        // --with keeps the pairwise exchange the addressed agent and one
        // peer name: the peer's labels on `from` against the agent's own
        // labels on `to`. `toLabel` is exactly that addressed-to-identity
        // test — channel posts and channel-addressed handoffs carry a
        // group:<channel>:* room address, never the peer, so they cannot
        // match; the reverse direction (agent→peer) cannot appear because
        // the inbox only holds mail addressed to the agent.
        (withMatch === undefined || (toLabel && withMatch(envelope.from))) &&
        (priority === undefined || envelope.priority === priority) &&
        (since === undefined || row.receivedAt >= since) &&
        (before === undefined || row.receivedAt < before) &&
        (channelFilter === undefined || channel === channelFilter) &&
        (bodyKindFilter === undefined || busBodyKind(envelope.body) === bodyKindFilter) &&
        (resultOutcome === undefined || busBodyResultOutcome(envelope.body) === resultOutcome) &&
        (containsNeedle === undefined || busReadContainsMatch(envelope.body, containsNeedle)) ? kind : null;
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
  annotateLiveEvidence(messages, options);
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
  | { statusId: string; jobId: string; status: WorkJob['status']; detail?: string; priority: BusPriority }
  | 'unresolved'
  | 'unknown';

/**
 * The live message a `bus.send` wake hint refers to. Every wake the bus
 * records carries the triggering envelope's wire id as its own `id`, so one
 * bounded store scan resolves the whole page: `resolved` reports the same
 * evidence an inbox row or `bus show` carries — summary, priority, sender
 * handle, and for claimable work or a job citation the `held`/`job`
 * annotations — while `unresolved` means the store was read and holds no
 * live envelope with that id (expired, reclaimed or never posted) and
 * `unknown` means the store could not be read, so the referent is unknown,
 * never absent-by-guess.
 */
export type AgentWakeMessage =
  | { status: 'resolved'; id: string; ts: string; priority: BusPriority;
      from: string; to: string; channel: string | null; fromAgent: string | null;
      summary: string;
      /** Live feed state of a job the message cites (`jobId` on a feed-citing body, `taskId` on a worker-handoff); absent when it cites none. */
      job?: BusEnvelopeLookupJob;
      /** Hold evidence for claimable work or worker handoffs; absent otherwise. */
      held?: boolean | null; holder?: string | null }
  | { status: 'unresolved' }
  | { status: 'unknown' };

/** A wake-queue row plus, on claim-holder hints only, the status receipt the hint cites,
 * and on ordinary `bus.send` hints, the live message the hint's id refers to. */
export type AgentWakeRow = BusWakeRow & { claimHolder?: AgentWakeClaimHolder; message?: AgentWakeMessage };

/**
 * Re-derive which terminal `work.status` receipt generated each `wh-…` hint
 * in the page. The fan-out hashes (status envelope id, holder label) and the
 * hint's own `to` is that label, so re-hashing every live terminal status
 * receipt reproduces the citation with no side journal. Only claim-holder-shaped ids
 * are attempted; every other hint passes through untouched. An unreadable bus
 * store marks them `'unknown'`; a readable one with no reproducing receipt
 * marks them `'unresolved'`.
 */
function claimHolderWakeContexts(rows: readonly BusWakeRow[], options: UnifiedBusOptions,
  scan?: BusInboxScan): Map<string, AgentWakeClaimHolder> {
  const hints = new Map<string, BusWakeRow>();
  for (const row of rows) if (CLAIM_HOLDER_WAKE_ID.test(row.id)) hints.set(row.id, row);
  const contexts = new Map<string, AgentWakeClaimHolder>();
  if (hints.size === 0) return contexts;
  const inbox = scan ?? scanBusInbox({ root: options.root, now: options.now });
  if (inbox.source === 'unavailable') {
    for (const id of hints.keys()) contexts.set(id, 'unknown');
    return contexts;
  }
  const owners = [...new Set([...hints.values()].map(row => row.to))];
  for (const receipt of inbox.rows) {
    if (contexts.size === hints.size) break;
    const body: unknown = receipt.envelope.body;
    if (body === null || typeof body !== 'object' || (body as { kind?: unknown }).kind !== 'work.status') continue;
    const parsed = workStatusBodySchema.safeParse(body);
    if (!parsed.success || !WORK_TERMINAL_STATUSES.has(parsed.data.status)) continue;
    for (const owner of owners) {
      const id = claimHolderWakeId(receipt.envelope.id, owner);
      if (!hints.has(id) || contexts.has(id)) continue;
      contexts.set(id, { statusId: receipt.envelope.id, jobId: parsed.data.jobId,
        status: parsed.data.status, priority: receipt.envelope.priority,
        ...(parsed.data.detail === undefined ? {} : { detail: parsed.data.detail }) });
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

/**
 * Resolve what each ordinary `bus.send` hint in the page refers to. The hint
 * id is the triggering envelope's wire id, so the same bounded scan the
 * claim-holder re-derivation uses indexes live receipts by id once; claimable
 * work and job citations then get the page-level `held`/`job` evidence
 * `readAgentInbox` computes — one hold-store read and one claims-joined feed
 * read per page, never per hint. `wh-…` ids are claim-holder hints, not
 * envelope ids, and pass through untouched. `match` names the referent-body
 * verdicts the page's filters need — the `job` citation rule plus the
 * `thread` label, `inReplyTo` citation, `bodyKind` discriminator and
 * `result` outcome the
 * inbox/channel reads apply —
 * each decided on the live body here, where it is still in hand, and
 * reported as the hint ids that provably match.
 */
function wakeMessageContexts(rows: readonly BusWakeRow[], scan: BusInboxScan | undefined,
  registry: AgentRegistry, options: UnifiedBusOptions,
  match?: { job?: string; thread?: string; inReplyTo?: string; bodyKind?: string; result?: WorkResultOutcome }):
  { contexts: Map<string, AgentWakeMessage>; jobMatches: Set<string>;
    threadMatches: Set<string>; inReplyToMatches: Set<string>; bodyKindMatches: Set<string>;
    resultMatches: Set<string> } {
  const contexts = new Map<string, AgentWakeMessage>();
  const jobMatches = new Set<string>();
  const threadMatches = new Set<string>();
  const inReplyToMatches = new Set<string>();
  const bodyKindMatches = new Set<string>();
  const resultMatches = new Set<string>();
  const ordinary = rows.filter(row => row.kind === 'bus.send' && !CLAIM_HOLDER_WAKE_ID.test(row.id));
  if (ordinary.length === 0) return { contexts, jobMatches, threadMatches, inReplyToMatches, bodyKindMatches, resultMatches };
  if (scan === undefined || scan.source === 'unavailable') {
    for (const row of ordinary) contexts.set(row.id, { status: 'unknown' });
    return { contexts, jobMatches, threadMatches, inReplyToMatches, bodyKindMatches, resultMatches };
  }
  const byId = new Map<string, BusInboxReceipt>();
  for (const receipt of scan.rows) byId.set(receipt.envelope.id, receipt);
  const resolved: { row: BusWakeRow; receipt: BusInboxReceipt }[] = [];
  for (const row of ordinary) {
    const receipt = byId.get(row.id);
    if (receipt === undefined) contexts.set(row.id, { status: 'unresolved' });
    else resolved.push({ row, receipt });
  }
  const jobIds = new Map<BusInboxReceipt, string>();
  for (const { receipt } of resolved) {
    const jobId = busBodyJobId(receipt.envelope.body);
    if (jobId !== undefined) jobIds.set(receipt, jobId);
  }
  let feed: BusWorkFeedReadResult | undefined;
  if (jobIds.size > 0) {
    try { feed = readBusWorkFeed({ root: options.root, now: options.now, claims: true }); }
    catch { feed = undefined; }
  }
  const holdable = new Set(resolved.filter(({ receipt }) =>
    isClaimableWork(receipt.envelope.body) || isWorkerHandoffBody(receipt.envelope.body))
    .map(({ receipt }) => receipt));
  const stores = holdable.size > 0 ? readHoldStores(options) : undefined;
  for (const { row, receipt } of resolved) {
    const envelope = receipt.envelope;
    const body = envelope.body;
    const jobId = jobIds.get(receipt);
    const hold = stores !== undefined && holdable.has(receipt)
      ? holdForReceipt({ id: envelope.id, cursor: receipt.cursor, receivedAt: receipt.receivedAt, envelope }, stores)
      : undefined;
    contexts.set(row.id, { status: 'resolved', id: envelope.id,
      ts: new Date(receipt.receivedAt).toISOString(), priority: envelope.priority,
      from: envelope.from, to: envelope.to, channel: envelope.channel ?? null,
      fromAgent: resolveAgent(registry, envelope.from)?.handle ?? null,
      summary: busBodySummary(body) ?? busBodyFallbackSummary(body),
      ...(jobId === undefined ? {} : { job: feed === undefined
        ? { jobId, feed: 'unavailable' } : jobAnnotationFromFeed(feed, jobId) }),
      ...(hold === undefined ? {} : { held: hold.held, holder: hold.holder }) });
    // The referent names the filtered job through the same rule every other
    // read surface's --job applies — a feed jobId citation, a worker-handoff
    // taskId or a job:<id> thread label — decided on the live body here,
    // where it is still in hand. The thread label and reply citation are the
    // same own-field matches the inbox and channel reads' --thread and
    // --in-reply-to apply to the message a hint refers to.
    if (match?.job !== undefined && busBodyJobMatch(body, match.job)) jobMatches.add(row.id);
    if (match?.thread !== undefined && busBodyThread(body) === match.thread) threadMatches.add(row.id);
    if (match?.inReplyTo !== undefined && busBodyInReplyToMatch(body, match.inReplyTo)) inReplyToMatches.add(row.id);
    if (match?.bodyKind !== undefined && busBodyKind(body) === match.bodyKind) bodyKindMatches.add(row.id);
    if (match?.result !== undefined && busBodyResultOutcome(body) === match.result) resultMatches.add(row.id);
  }
  return { contexts, jobMatches, threadMatches, inReplyToMatches, bodyKindMatches, resultMatches };
}

/** Human suffix naming the message an ordinary wake hint refers to; '' on claim-holder hints. */
export function agentWakeMessageSuffix(wake: AgentWakeRow): string {
  const message = wake.message;
  if (message === undefined) return '';
  if (message.status === 'unknown') return ' referent=unknown';
  if (message.status === 'unresolved') return ' referent=unresolved';
  const held = message.held === undefined ? '' :
    ` held=${message.held === null ? 'unknown' : message.held ? 'yes' : 'no'}${message.holder ? ` holder=${message.holder}` : ''}`;
  const job = message.job === undefined ? '' : ` ${busInboxJobMarker(message.job)}`;
  const summary = message.summary.length > 80 ? `${message.summary.slice(0, 79)}…` : message.summary;
  return ` msg="${summary}"${held}${job}`;
}

/**
 * Compact `job=<id>:<state>` marker naming the live feed state a body
 * kind's job citation resolves to — shared by the inbox
 * human line, the `--frame` adapter block and `work mine`'s inbox lines so
 * every surface renders it identically. An open job's `claimable` tri-state
 * rides along when the claims-joined feed read computed it; a refused feed
 * keeps its reason, an unreadable one its own state — never a guessed job.
 */
export function busInboxJobMarker(job: BusEnvelopeLookupJob): string {
  if (job.feed === 'ok') {
    if (job.job === null) return `job=${job.jobId}:absent`;
    const claimable = job.job.claimable === undefined ? ''
      : ` claimable=${job.job.claimable === null ? 'unknown' : job.job.claimable ? 'yes' : 'no'}`;
    const result = job.job.result === undefined ? '' : ` result=${job.job.result.outcome}`;
    return `job=${job.jobId}:${job.job.status}${result}${claimable}`;
  }
  if (job.feed === 'refused') return `job=${job.jobId}:refused:${job.reason}`;
  return `job=${job.jobId}:${job.feed}`;
}

/** A ref that resolves to no identity may still name a routing label: wake
 *  `to` values are the literal labels hints were queued under — the
 *  claim-holder fan-out writes the raw coordination owner label, which need
 *  not be a registered identity — so the read keeps exact-label matching like
 *  the claim/next/owner filters. 256 chars covers the claim-owner label bound. */
const WAKE_HINT_LABEL = /^[\x21-\x7e]{1,256}$/;

export type WakePage = { status: 'ok'; agent: string;
  /** 'identity' matched every spelling that resolves to a registered identity (exact, then lowercase) plus its member channels; 'label' is the literal-`to` fallback for a ref that resolves to no identity — `agent` then reports the queried label verbatim. */
  scope: 'identity' | 'label';
  wakes: AgentWakeRow[];
  /** Every hint the bounded queue read matched for the agent, before its row cap; `wakes` shows only the newest slice. With a `job` filter this counts the proven job matches on the resolved page instead — the same accepted-hints count, never a total beyond `truncated`. */
  matched: number;
  /** The queue tail or row cap cut matches beyond `wakes`; false only when the bounded read provably saw them all. */
  truncated: boolean } |
  { status: 'unknown-agent' | 'unavailable' | 'invalid'; reason: string };

/**
 * One page of every wake hint in the bounded queue tail — the fleet-wide
 * companion to `readAgentWakes`: no addressee scope, so hints queued under
 * bare coordination or routing labels (the claim-holder fan-out's raw
 * claim-owner targets) appear beside registered identities' hints, each
 * row's own `to` naming its addressee. `scope:'fleet'` marks the unscoped
 * read. `matched`/`truncated` carry the same queue-tail semantics
 * `readAgentWakes` documents — `matched` counts every hint the bounded
 * tail accepted before the row cap, or the proven matches on the resolved
 * page under `job`/`contains`/`priority`/`thread`/`inReplyTo`/`bodyKind`,
 * and `truncated` marks older bytes or matched rows beyond the returned
 * slice.
 */
export type AllWakesPage =
  | { status: 'ok'; scope: 'fleet'; wakes: AgentWakeRow[]; matched: number; truncated: boolean }
  | { status: 'unavailable' | 'invalid'; reason: string };

/** The filter set every wake read shares: one job id, sender include/exclude, one channel, one priority band, contains text, one v2 thread label, one reply citation, one body-kind discriminator, one work-result outcome, the exclusive upper time bound and one exact hint id. */
interface WakeFilter { job?: string; from?: string; excludeFrom?: string; channel?: string; contains?: string; priority?: BusPriority; before?: number; id?: string; thread?: string; inReplyTo?: string; bodyKind?: string; result?: WorkResultOutcome }

type ParsedWakeFilter = { ok: true; job?: string; from?: string; excludeFrom?: string; channel?: string; containsNeedle?: string; priority?: BusPriority; before?: number; id?: string; thread?: string; inReplyTo?: string; bodyKind?: string; result?: WorkResultOutcome }
  | { ok: false; reason: string };

/** Validate the shared wakes filter set before any store is touched. */
function parseWakeFilter(filter: WakeFilter): ParsedWakeFilter {
  const job = filter.job;
  if (job !== undefined && (typeof job !== 'string' || !THREAD.test(job))) {
    return { ok: false, reason: 'Invalid job id.' };
  }
  const id = filter.id;
  if (id !== undefined && (typeof id !== 'string' || !THREAD.test(id))) {
    return { ok: false, reason: 'Invalid message id.' };
  }
  const thread = filter.thread;
  if (thread !== undefined && (typeof thread !== 'string' || !THREAD.test(thread))) {
    return { ok: false, reason: 'Invalid thread label.' };
  }
  const inReplyTo = filter.inReplyTo;
  if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !THREAD.test(inReplyTo))) {
    return { ok: false, reason: 'Invalid in-reply-to id.' };
  }
  const bodyKind = filter.bodyKind;
  if (bodyKind !== undefined && (typeof bodyKind !== 'string' || !THREAD.test(bodyKind))) {
    return { ok: false, reason: 'Invalid body kind.' };
  }
  const result = filter.result;
  if (result !== undefined && !(WORK_RESULT_OUTCOMES as readonly string[]).includes(result)) {
    return { ok: false, reason: 'Invalid result outcome.' };
  }
  const priority = filter.priority;
  if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) {
    return { ok: false, reason: 'Invalid priority.' };
  }
  const from = filter.from;
  if (from !== undefined && (typeof from !== 'string' || from.length === 0 || from.length > 128)) {
    return { ok: false, reason: 'Invalid sender filter.' };
  }
  const excludeFrom = filter.excludeFrom;
  if (excludeFrom !== undefined &&
      (typeof excludeFrom !== 'string' || excludeFrom.length === 0 || excludeFrom.length > 128)) {
    return { ok: false, reason: 'Invalid sender-exclusion filter.' };
  }
  const channel = filter.channel;
  if (channel !== undefined && (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success)) {
    return { ok: false, reason: 'Invalid channel name.' };
  }
  const before = filter.before;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    return { ok: false, reason: 'Invalid before.' };
  }
  const containsNeedle = busReadContains(filter.contains);
  if (containsNeedle === null) return { ok: false, reason: 'Invalid contains filter.' };
  return { ok: true, ...(job === undefined ? {} : { job }),
    ...(from === undefined ? {} : { from }), ...(excludeFrom === undefined ? {} : { excludeFrom }),
    ...(channel === undefined ? {} : { channel }),
    ...(priority === undefined ? {} : { priority }),
    ...(before === undefined ? {} : { before }),
    ...(id === undefined ? {} : { id }),
    ...(thread === undefined ? {} : { thread }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(bodyKind === undefined ? {} : { bodyKind }),
    ...(result === undefined ? {} : { result }),
    ...(containsNeedle === undefined ? {} : { containsNeedle }) };
}

/** The annotated rows plus queue-tail counts every wake page reports. */
type WakeRowsPage = { status: 'ok'; wakes: AgentWakeRow[]; matched: number; truncated: boolean }
  | { status: 'unavailable'; reason: string };

/**
 * The queue-tail read plus referent resolution every wake page shares.
 * `match` decides addressee scope inside `readBusWakes`, so `matched`
 * counts only rows the whole filter set accepts; one bounded store scan
 * then resolves each row's `claimHolder`/`message` evidence and the
 * `job`/`contains`/`priority`/`thread`/`inReplyTo`/`bodyKind`/`result`
 * verdicts
 * filter on that resolved text — an unreadable queue is `unavailable`,
 * and a `job`/`contains`/`priority`/`thread`/`inReplyTo`/`bodyKind`/`result`
 * read
 * whose bus store cannot be read fails closed the same way, never an
 * empty page passed off as "no wakes".
 */
function readWakeRows(sinceAt: number | undefined, options: UnifiedBusOptions, registry: AgentRegistry,
  match: (wake: BusWakeRow) => boolean, filter: ParsedWakeFilter & { ok: true }): WakeRowsPage {
  const wakes = readBusWakes({ root: options.runsRoot, sinceAt, beforeAt: filter.before, match });
  if (wakes.state === 'unreadable') return { status: 'unavailable', reason: 'Wake queue is unreadable.' };
  // One bounded store scan serves both per-row resolutions: the claim-holder
  // citation re-derivation and the ordinary hint's referent lookup.
  const scan = wakes.wakes.length === 0 ? undefined
    : scanBusInbox({ root: options.root, now: options.now });
  const job = filter.job, containsNeedle = filter.containsNeedle, priority = filter.priority;
  const thread = filter.thread, inReplyTo = filter.inReplyTo, bodyKind = filter.bodyKind;
  const result = filter.result;
  // A job, contains, priority, thread, reply-citation, body-kind or
  // result-outcome verdict
  // needs the resolved referent; when the store cannot be read every hint's
  // citation, summary, band, body fields and outcome are unknown, so the
  // filtered
  // read fails closed instead of reporting an empty page as "no wakes for
  // this job", "no wakes mentioning this", "no urgent wakes", "no wakes in
  // this thread", "no wakes answering that message", "no wakes about
  // this body kind" or "no wakes reporting that result".
  if ((job !== undefined || containsNeedle !== undefined || priority !== undefined ||
       thread !== undefined || inReplyTo !== undefined || bodyKind !== undefined ||
       result !== undefined) &&
      scan !== undefined && scan.source === 'unavailable') {
    return { status: 'unavailable', reason: 'Bus store is not readable.' };
  }
  const contexts = claimHolderWakeContexts(wakes.wakes, options, scan);
  const resolved = wakeMessageContexts(wakes.wakes, scan, registry, options, { job, thread, inReplyTo, bodyKind, result });
  const shown = wakes.wakes.filter(row => {
    if (job !== undefined) {
      const holder = contexts.get(row.id);
      const jobMatch = typeof holder === 'object' ? holder.jobId === job : resolved.jobMatches.has(row.id);
      if (!jobMatch) return false;
    }
    // A claim-holder hint's referent is a work.status receipt, which carries
    // no thread label or reply citation, so wh-… ids never enter these sets.
    if (thread !== undefined && !resolved.threadMatches.has(row.id)) return false;
    if (inReplyTo !== undefined && !resolved.inReplyToMatches.has(row.id)) return false;
    if (bodyKind !== undefined) {
      // The citing work.status receipt behind a resolved claim-holder hint
      // provably carries that body kind; 'unresolved'/'unknown' holders and
      // ordinary hints name no provable kind and never match.
      const holder = contexts.get(row.id);
      const kindMatch = typeof holder === 'object' ? bodyKind === 'work.status'
        : resolved.bodyKindMatches.has(row.id);
      if (!kindMatch) return false;
    }
    if (result !== undefined && !resolved.resultMatches.has(row.id)) return false;
    if (containsNeedle !== undefined &&
        !wakeHintContainsMatch(contexts.get(row.id), resolved.contexts.get(row.id), containsNeedle)) {
      return false;
    }
    if (priority !== undefined) {
      // The band is the resolved referent's own priority — the live message a
      // bus.send hint points at, or the citing work.status receipt behind a
      // claim-holder wh-… hint. A hint whose referent is unresolved or
      // unknown names no provable band and never matches.
      const holder = contexts.get(row.id);
      const message = resolved.contexts.get(row.id);
      const band = typeof holder === 'object' ? holder.priority
        : message?.status === 'resolved' ? message.priority : undefined;
      if (band !== priority) return false;
    }
    return true;
  });
  return { status: 'ok',
    wakes: shown.map(row => {
      const claimHolder = contexts.get(row.id);
      const message = resolved.contexts.get(row.id);
      return { ...row,
        ...(claimHolder === undefined ? {} : { claimHolder }),
        ...(message === undefined ? {} : { message }) };
    }),
    matched: job === undefined && containsNeedle === undefined && priority === undefined &&
      thread === undefined && inReplyTo === undefined && bodyKind === undefined &&
      result === undefined ? wakes.matched ?? 0 : shown.length,
    truncated: wakes.truncated ?? false };
}

/**
 * Wake hints addressed to this identity under any spelling that resolves to
 * it — the `agent:<handle>` address, bare handle, stable id or alias, exact
 * first then lowercase, the same addressed-to fold the inbox read and every
 * other addressed-to match applies — or to one of its channels after
 * `sinceAt`. A ref that resolves to no registered identity keeps exact-label
 * matching instead — `scope:'label'`, `agent` the queried label — so hints
 * queued under a bare coordination or routing label (claim-holder fan-out
 * writes the raw claim-owner label) stay readable by their addressee; only
 * `wake.to === ref` matches, never a widened set. A wake is only a hint to
 * read the inbox: it carries routing ids, never a body, and grants nothing.
 * Claim-holder hints (`wh-…` ids) carry no
 * envelope id of their own, so each is re-resolved against the live
 * `work.status` receipts that could have generated it and annotated with the
 * citing status — `unresolved` when none reproduces it, `unknown` when the
 * bus store cannot be read. Every other `bus.send` hint carries the
 * triggering envelope's wire id as its own `id`, so the same bounded scan
 * resolves the live message it refers to: `message` reports the resolved
 * receipt's summary, priority, sender handle and — for claimable work or a
 * job citation — the same `held`/`job` evidence an inbox row carries,
 * `unresolved` when no live envelope has that id, and `unknown` when the
 * store cannot be read. `matched` counts every hint the bounded
 * queue tail matched before its row cap and `truncated` marks older bytes or
 * matched rows beyond the returned slice — an unreadable queue stays
 * `unavailable`, never an empty page passed off as "no wakes".
 * `filter.job` keeps only hints that provably name one job — the same
 * `busBodyJobMatch` rule `inbox --job`/`channel read --job` apply to the
 * message a hint refers to (a feed `jobId` citation, a `worker-handoff`
 * `taskId` or a `job:<id>` thread label), or the `jobId` a claim-holder
 * hint's citing status carries; a hint whose referent is `unresolved` or
 * `unknown` names no provable job and never matches. Because the verdict
 * needs the resolved referent, an unreadable bus store makes the filtered
 * read `unavailable` rather than an empty page, and `matched` then counts
 * the proven matches on the resolved page while `truncated` keeps its
 * queue-tail meaning. `filter.from` keeps only hints whose recorded `from`
 * label matches one agent — the same `agentRefAddressMatcher` identity-label
 * rule `inbox --from`/`channel read --from` apply over the already-read
 * registry: a handle, `agent:<handle>`, stable id or alias matches every
 * label of that identity, and an unresolvable ref keeps exact-label
 * matching, so unknown identity state never widens the filter. The matched
 * label is the hint row's own `from` — the triggering envelope's sender on
 * a `bus.send` hint, the `agent:<handle>` of the identity whose terminal
 * `work.status` generated a claim-holder `wh-…` hint — so "which agent
 * keeps waking me" is one filtered read that composes with `--since` and
 * `--job`. `filter.excludeFrom` drops hints sent under every registered
 * spelling of one identity through the same matcher — an unresolvable ref
 * keeping exact-label matching — composing with `from` so a sender both
 * included and excluded matches nothing, the same rule
 * `readAgentInbox`/`readAgentChannel`'s `excludeFrom` apply; the drop
 * happens inside the queue-tail match, so `matched` stays the count the
 * whole filter set accepts. `filter.channel` keeps only hints whose own
 * `to` label sits under `group:<name>:*` — the same room prefix
 * `inbox --channel`, `channel read` and `phm messages --channel` match,
 * grammar-validated by the shared channel-name rule and decided on the
 * hint's address alone, so it needs no referent resolution, composes
 * with the addressee scope (a per-agent read narrows to one room's hints
 * for that agent — a channel the agent does not belong to simply has no
 * hints to show) and with every other filter, `matched` counting it with
 * the rest of the queue-tail match; a name no hint addresses matches
 * nothing rather than erroring. `filter.contains` keeps only hints whose
 * resolved referent text carries the needle — a `bus.send` hint's live
 * message summary or a claim-holder hint's citing `work.status` detail,
 * the same scrubbed one-line text the row reports — so "which wake was
 * about X" is one filtered read; a hint whose referent cannot be
 * resolved names no provable text and never matches, and like `job` the
 * filtered `matched` counts the proven matches on the resolved page.
 * `filter.priority` keeps only hints in one exact P0..P3 band — the same
 * match every other bus read's `--priority` applies — decided on the
 * resolved referent's own priority: the live message a `bus.send` hint
 * points at, or the citing `work.status` receipt's band behind a
 * claim-holder `wh-…` hint, with `unresolved`/`unknown` referents never
 * matching (they name no provable band), `matched` counting the proven
 * matches on the resolved page, an unreadable bus store answering
 * `unavailable`, and a band outside P0..P3 answering `invalid`.
 * `filter.thread` keeps only hints whose resolved referent is a
 * `note`/`context` body carrying that v2 thread label — the same
 * `busBodyThread` own-field match `inbox --thread` and `channel read
 * --thread` apply to the message a hint refers to — so "which wake was
 * about thread T" is one filtered read; a claim-holder `wh-…` hint's
 * referent is a `work.status` receipt, which carries no thread label, so
 * those hints never match, an `unresolved`/`unknown` referent names no
 * provable thread and never matches, an unreadable bus store answers
 * `unavailable`, `matched` counts the proven matches on the resolved
 * page, and a malformed label answering `invalid`. `filter.inReplyTo`
 * keeps only hints whose resolved referent body cites that envelope id
 * through its own `inReplyTo` field — the same own-property exact match
 * `inbox --in-reply-to`, `channel read --in-reply-to`, `phm messages
 * --in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet
 * bus-follow --in-reply-to` and `fleet_bus_inbox`'s `inReplyTo` apply,
 * never the `replyTo` alias or a substring — so "did the reply to
 * envelope X trigger a wake" is one filtered read; claim-holder hints
 * never match for the same reason, `unresolved`/`unknown` referents
 * never match, the unreadable-store and `matched` rules are `thread`'s,
 * and a malformed id answering `invalid`.
 * `filter.bodyKind` keeps only hints whose resolved referent body carries
 * that exact kind discriminator — the same `busBodyKind` match
 * `inbox --body-kind` and `channel read --body-kind` apply to the message
 * a hint refers to: the v2 `kind` field, a `worker-handoff` assignment,
 * a bus-transport v1 `protocol.kind`, or a `type`/`schema` notice
 * discriminator, matched exactly and case-sensitively so "which wakes
 * were about `work.status` receipts" or "which wakes cite `work.post`
 * announcements" is one filtered read; a claim-holder `wh-…` hint's
 * citing receipt provably carries `work.status`, so those hints match
 * only that kind and `unresolved`/`unknown` referents never match, an
 * unreadable bus store answers `unavailable`, `matched` counts the
 * proven matches on the resolved page, and a malformed value answering
 * `invalid`.
 * `filter.result` keeps only hints whose resolved referent is a
 * `work.result` body reporting that one outcome — the same
 * `WORK_RESULT_OUTCOMES` codes and kind-scoped `busBodyResultOutcome`
 * own-field match `inbox --result` and `channel read --result` apply,
 * so "which wakes were triggered by a failed result receipt" is one
 * filtered read; a claim-holder `wh-…` hint's citing receipt is a
 * `work.status` body, which provably reports no result outcome, so
 * those hints never match and neither do `unresolved`/`unknown`
 * referents (they name no provable outcome) nor a `work.result` body
 * carrying no outcome or one outside the vocabulary — the same "unknown
 * stays out" rule every other resolved-referent filter keeps, an
 * unreadable bus store answering `unavailable`, `matched` counting the
 * proven matches on the resolved page, and an outcome outside
 * `WORK_RESULT_OUTCOMES` answering `invalid`.
 * `filter.before` keeps only hints recorded strictly before that
 * epoch-ms cutoff — the exclusive upper bound every bus read's `--before`
 * applies on the hint's own queue time, composing with `sinceAt`'s
 * strictly-after boundary into one `(since, before)` window; the verdict
 * needs only the queue row's `at`, never the resolved referent, so it
 * counts inside the queue-tail match like `channel`/`from`/`excludeFrom`
 * and an unreadable bus store never fails it closed, with a bound outside
 * epoch-ms answering `invalid`.
 */
export function readAgentWakes(ref: string, sinceAt: number | undefined, options: UnifiedBusOptions = {},
  filter: WakeFilter = {}): WakePage {
  const parsed = parseWakeFilter(filter);
  if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (target === undefined && !WAKE_HINT_LABEL.test(ref)) {
    return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  }
  const identityOf = labelIdentityOf(read.registry);
  const fromMatch = parsed.from === undefined ? undefined
    : agentRefAddressMatcher(parsed.from, read.registry, identityOf);
  const excludeFromMatch = parsed.excludeFrom === undefined ? undefined
    : agentRefAddressMatcher(parsed.excludeFrom, read.registry, identityOf);
  const channelPrefix = parsed.channel === undefined ? undefined : `group:${parsed.channel}:`;
  const page = readWakeRows(sinceAt, options, read.registry, wake =>
    (parsed.id === undefined || wake.id === parsed.id) &&
    (channelPrefix === undefined || wake.to.startsWith(channelPrefix)) &&
    (fromMatch === undefined || fromMatch(wake.from)) &&
    (excludeFromMatch === undefined || !excludeFromMatch(wake.from)) &&
    // The addressee label folds to its identity exactly as the inbox read
    // and every other addressed-to match does; the channel self-exclusion
    // stays on the exact stored labels like `agentPendingAddressMatcher`.
    (target !== undefined
      ? identityOf(wake.to) === target.identity.id
        || (channelOf(wake.to, target.channels) !== null && !target.labels.has(wake.from))
      : wake.to === ref), parsed);
  if (page.status !== 'ok') return page;
  return { status: 'ok', agent: target?.identity.handle ?? ref,
    scope: target === undefined ? 'label' : 'identity',
    wakes: page.wakes, matched: page.matched, truncated: page.truncated };
}

/**
 * Every wake hint the bounded queue tail holds, fleet-wide — the read a
 * leader or comms pass runs once instead of `readAgentWakes` per
 * registered identity (and once more per bare coordination label the
 * claim-holder fan-out writes, which no identity ref can name). Rows
 * carry the same `claimHolder`/`message` resolution `readAgentWakes`
 * annotates, so fleet triage costs the same zero extra reads; the
 * `since`/`job`/`from`/`excludeFrom`/`channel`/`contains`/`priority`/`before`/
 * `thread`/`inReplyTo`/`bodyKind`/`result`
 * filters behave identically — `channel` keeps only hints whose own `to`
 * label sits under `group:<name>:*`, the room prefix every other bus read's
 * channel filter matches, decided on the address alone inside the
 * queue-tail match so `matched` counts it with the rest, `before` keeps
 * only hints recorded strictly before its epoch-ms cutoff — the same
 * exclusive upper bound `readAgentWakes`' `filter.before` applies on the
 * hint's queue time — including the fail-closed
 * `unavailable` when a
 * `job`/`contains`/`priority`/`thread`/`inReplyTo`/`bodyKind`/`result`
 * verdict
 * needs a bus store that cannot be read. An unreadable registry or queue is
 * `unavailable`, never an
 * empty page passed off as "no wakes". `filter.id` keeps only the hint
 * whose own id is strictly equal to the value — the triggering envelope's
 * wire id on a `bus.send` hint, the `wh-…` claim-holder id on those — the
 * same exact-id match `agents bus inbox`/`channel read`'s `id` apply,
 * decided on the queue row alone inside the queue-tail match so it
 * counts in `matched` and needs no referent resolution.
 */
export function readAllWakes(sinceAt: number | undefined, options: UnifiedBusOptions = {},
  filter: WakeFilter = {}): AllWakesPage {
  const parsed = parseWakeFilter(filter);
  if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const fromMatch = parsed.from === undefined ? undefined
    : agentRefAddressMatcher(parsed.from, read.registry, labelIdentityOf(read.registry));
  const excludeFromMatch = parsed.excludeFrom === undefined ? undefined
    : agentRefAddressMatcher(parsed.excludeFrom, read.registry, labelIdentityOf(read.registry));
  const channelPrefix = parsed.channel === undefined ? undefined : `group:${parsed.channel}:`;
  const page = readWakeRows(sinceAt, options, read.registry, wake =>
    (parsed.id === undefined || wake.id === parsed.id) &&
    (channelPrefix === undefined || wake.to.startsWith(channelPrefix)) &&
    (fromMatch === undefined || fromMatch(wake.from)) &&
    (excludeFromMatch === undefined || !excludeFromMatch(wake.from)), parsed);
  if (page.status !== 'ok') return page;
  return { status: 'ok', scope: 'fleet', wakes: page.wakes, matched: page.matched, truncated: page.truncated };
}

/**
 * The `--contains` verdict for one wake hint, decided on the same resolved
 * evidence the row reports: a `bus.send` hint matches when its live referent
 * message's scrubbed one-line summary — the same text `agentWakeMessageSuffix`
 * renders — carries the needle, and a claim-holder `wh-…` hint matches when
 * the citing `work.status` receipt's detail carries it. A hint whose referent
 * is `unresolved` or `unknown` names no provable text and never matches,
 * the same rule the `job` filter applies; ids, labels and statuses stay
 * structured fields, never search text.
 */
function wakeHintContainsMatch(claimHolder: AgentWakeClaimHolder | undefined,
  message: AgentWakeMessage | undefined, needle: string): boolean {
  if (message?.status === 'resolved' &&
      message.summary.toLowerCase().replace(/\s+/g, ' ').includes(needle)) return true;
  return typeof claimHolder === 'object' && claimHolder.detail !== undefined &&
    scrubSecrets(claimHolder.detail).toLowerCase().replace(/\s+/g, ' ').includes(needle);
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
  /**
   * Claimable work and worker-handoff bodies only: whether a taken
   * message-id claim or a live coordination hold provably covers the exact
   * receipt — the same evidence `bus show` and `agents bus inbox` report.
   * `held` false is proof of free; null means a hold store could not be
   * read (unknown, never proven free). Absent on every other body kind.
   */
  held?: boolean | null;
  /** Owner label of the blocking claim when held and known; null otherwise. */
  holder?: string | null;
  /**
   * Bodies that name a job (`work.post`, `work.status`, `work.result` or
   * `wake` declaring a `jobId`, or a `worker-handoff` assigning its fleet
   * job id through `taskId`): the live work-feed state of the job the body
   * cites — the same `BusEnvelopeLookupJob` `bus show` resolves, computed
   * with one feed read per page so a channel transcript answers where each
   * announced job stands without a lookup per message. Absent on every
   * other body kind.
   */
  job?: BusEnvelopeLookupJob;
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
   * Sender-exclusion filter: a handle, `agent:<handle>`, stable id or alias.
   * A ref that resolves through the identity registry drops posts sent under
   * every label of that identity; an unresolvable ref keeps exact-label
   * matching — the same `agentRefAddressMatcher` rule `comms bus read|watch
   * --exclude-from`, `fleet bus-follow --exclude-from` and `fleet_bus_inbox`'s
   * `excludeFrom` apply, so a room's noisy member never reaches the
   * transcript while every other sender still does. It composes with `from`
   * (a sender both included and excluded matches nothing) and with every
   * other filter.
   */
  excludeFrom?: string;
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
  /**
   * Job filter: only posts that name this one job — the same
   * `busBodyJobMatch` rule `agents bus inbox --job` applies: a feed-citing
   * body (`work.post`, `work.status`, `work.result` or `wake`) declaring
   * that `jobId`, a `worker-handoff` assigning that fleet job id through
   * `taskId`, or a `note`/`context` body carrying the `job:<id>` v2 thread
   * label. Every other body kind cites no job and never matches.
   */
  job?: string;
  /**
   * Ask for the true pending total: the scan then covers the whole retained
   * store instead of stopping at `limit`, counting every post the same
   * filters accept while `messages` still returns only the first `limit`.
   */
  matched?: boolean;
  /**
   * Time filter: only posts received at or after this epoch-ms cutoff — the
   * same inclusive `receivedAt >= since` match `agents bus inbox --since`
   * and `phm messages --since` apply, so a room's recent traffic is one
   * filtered read without a persisted cursor.
   */
  since?: number;
  /**
   * Time filter: only posts received strictly before this epoch-ms cutoff —
   * the exclusive upper bound every bus read's `--before` applies —
   * composing with `since` into one `[since, before)` window on
   * `receivedAt`, so "what did the room say before time T" is one filtered
   * read.
   */
  before?: number;
  /**
   * Text filter: only posts whose scrubbed one-line summary — the same
   * text the inbox frame renders per row — carries the needle as a
   * case-insensitive substring. Matching runs over the rendered summary,
   * never the raw body, so a secret-shaped value stays unfindable even
   * though it sits in the stored envelope.
   */
  contains?: string;
  /**
   * Reply-citation filter: only posts whose object body cites this envelope
   * id through its own `inReplyTo` field — the same own-property exact
   * match `agents bus inbox --in-reply-to`, `phm messages --in-reply-to`,
   * `comms bus read|watch --in-reply-to`, `fleet bus-follow --in-reply-to`
   * and `fleet_bus_inbox`'s `inReplyTo` apply, never the `replyTo` alias
   * or a substring — so "which room posts answer envelope X" is one
   * filtered read of the transcript.
   */
  inReplyTo?: string;
  /**
   * Envelope-id filter: only the post whose own wire id is strictly equal
   * to this value — the same exact-match `comms bus read|watch --id`,
   * `fleet bus-follow --id` and `fleet_bus_inbox`'s `id` apply, never a
   * substring or a body citation — so "did envelope X reach the room" is
   * one filtered read of the transcript.
   */
  id?: string;
  /**
   * Body-kind filter: only posts whose body carries this exact kind
   * discriminator — the v2 `kind` field (`note`, `context`, `work.post`,
   * `work.claim`, `work.status`, `work.result`, `work.release`, `wake`), a
   * `worker-handoff` assignment or a notice kind, a bus-transport v1
   * `protocol.kind`, or a `type`/`schema` notice discriminator — the same
   * discriminator `busBodySummary` switches on, matched exactly and
   * case-sensitively. A body carrying no discriminator never matches, so
   * "which room posts are work results" or "which are wake requests" is one
   * filtered read of the transcript, composing with every other filter.
   */
  bodyKind?: string;
  /**
   * Result-outcome filter: only posts whose body is a `work.result`
   * receipt reporting this outcome — the same `WORK_RESULT_OUTCOMES`
   * vocabulary the work feed's `--result` filter and `phm messages
   * --result` validate, read through the kind-scoped
   * `busBodyResultOutcome` own-field match, so every other body kind and
   * a result carrying no outcome never matches.
   */
  result?: WorkResultOutcome;
  after?: number;
  limit?: number;
}
export type ChannelReadPage =
  | { status: 'ok'; channel: string; messages: ChannelReadMessage[]; nextCursor: number;
      /** Every filter-matched post across the whole scan, present only when
       * the read asked for it (`page.matched`); `messages` still caps at
       * `limit`. */
      matched?: number }
  | { status: 'invalid' | 'unknown-channel' | 'unavailable' | 'retryable'; reason: string };

/**
 * One page of a channel's posts, oldest first: every live envelope addressed
 * to `group:<name>:*` — or to one `topic` — except `group.presence`
 * heartbeats, which are expiring observations with their own read
 * (`groupPresence`), not messages. Reading needs no identity and no
 * membership: membership gates posting only, and the rows are the same
 * shared store `comms bus group read` sees. `from` narrows by sender through
 * the same identity-label matching `comms bus read` uses; `excludeFrom`
 * drops posts sent under every registered spelling of one identity — the
 * same sender-exclusion rule `comms bus read|watch --exclude-from`,
 * `fleet bus-follow --exclude-from` and `fleet_bus_inbox`'s `excludeFrom`
 * apply, with an unresolvable ref keeping exact-label matching — so a room's
 * noisy member never reaches the transcript; `thread` narrows to
 * `note`/`context` bodies carrying that v2 thread label, `priority`
 * narrows to posts stamped with that exact P0..P3 band, and `job` narrows
 * to posts that name one job — the same `busBodyJobMatch` rule `agents bus
 * inbox --job` applies, so a channel transcript answers one job's posts
 * without paging the whole room. `since` keeps only posts received at or
 * after that epoch-ms cutoff — the same `receivedAt >= since` match
 * `inbox --since` applies; `before` keeps only posts received strictly
 * before its epoch-ms cutoff — the exclusive upper bound composing with
 * `since` into one `[since, before)` window on `receivedAt`. `contains`
 * keeps only posts whose scrubbed
 * one-line summary — the same text the inbox frame renders per row —
 * carries the needle as a case-insensitive substring, the same
 * `busReadContainsMatch` rule `inbox --contains` applies, so "has anyone
 * posted about X in this room" is one filtered read; matching runs over
 * the rendered summary, never the raw body. `inReplyTo` keeps only posts
 * whose object body cites that envelope id through its own `inReplyTo`
 * field — the same own-property exact match `inbox --in-reply-to`,
 * `phm messages --in-reply-to` and the raw bus reads apply, never the
 * `replyTo` alias or a substring — so "which room posts answer envelope
 * X" is one filtered read of the transcript. `bodyKind` keeps only posts
 * whose body carries that exact kind discriminator — the v2 `kind` field,
 * a `worker-handoff` assignment, a notice kind, a bus-transport v1
 * `protocol.kind` or a `type`/`schema` notice discriminator, the same
 * discriminator `busBodySummary` switches on — matched exactly and
 * case-sensitively, so "which room posts are work results" or "which are
 * wake requests" is one filtered read of the transcript; a body carrying
 * no discriminator never matches. `result` keeps only posts whose body
 * is a `work.result` receipt reporting that one outcome — the same
 * `WORK_RESULT_OUTCOMES` codes the work feed's `--result` filter and
 * `phm messages --result` validate, read through the kind-scoped
 * `busBodyResultOutcome` own-field match — so every other body kind (a
 * `work.release` body's own `released`/`completed` outcome included) and
 * a `work.result` carrying no outcome never matches: "which room posts
 * are failed result receipts" is one filtered read of the transcript.
 * `nextCursor`
 * covers every scanned row, so callers persist it only after handling the
 * page; `page.matched` asks for the true pending total the way
 * `readAgentInbox` does — the scan then covers the whole retained store,
 * counting every post the same filters accept while `messages` still caps
 * at `limit`. Returned rows carry the same live evidence `agents bus
 * inbox` annotates: claimable work and worker-handoff posts report
 * `held`/`holder` and feed-citing bodies (`work.post`, `work.status`,
 * `work.result`, `wake`) report `job`, each store read once per page and
 * only when a candidate is present. A missing registry means no channel
 * exists, an unreadable one or an unreadable store is reported, never an
 * empty page passed off as history.
 */
export function readAgentChannel(name: string, page: ChannelReadOptions = {}, options: UnifiedBusOptions = {}): ChannelReadPage {
  const after = page.after ?? 0, limit = page.limit ?? 50, thread = page.thread, priority = page.priority, job = page.job;
  const countMatched = page.matched === true, since = page.since, before = page.before, inReplyTo = page.inReplyTo;
  const idFilter = page.id, bodyKindFilter = page.bodyKind, resultOutcome = page.result;
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
  if (job !== undefined && (typeof job !== 'string' || !THREAD.test(job))) {
    return { status: 'invalid', reason: 'Invalid job id.' };
  }
  if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !THREAD.test(inReplyTo))) {
    return { status: 'invalid', reason: 'Invalid in-reply-to id.' };
  }
  if (idFilter !== undefined && (typeof idFilter !== 'string' || !THREAD.test(idFilter))) {
    return { status: 'invalid', reason: 'Invalid message id.' };
  }
  if (bodyKindFilter !== undefined && (typeof bodyKindFilter !== 'string' || !THREAD.test(bodyKindFilter))) {
    return { status: 'invalid', reason: 'Invalid body kind.' };
  }
  if (resultOutcome !== undefined && !(WORK_RESULT_OUTCOMES as readonly string[]).includes(resultOutcome)) {
    return { status: 'invalid', reason: 'Invalid result outcome.' };
  }
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { status: 'invalid', reason: 'Invalid since.' };
  }
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
    return { status: 'invalid', reason: 'Invalid before.' };
  }
  const containsNeedle = busReadContains(page.contains);
  if (containsNeedle === null) {
    return { status: 'invalid', reason: 'Invalid contains filter.' };
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
    fromMatch = agentRefAddressMatcher(page.from, read.registry, labelIdentityOf(read.registry));
  }
  let excludeFromMatch: ((value: string) => boolean) | undefined;
  if (page.excludeFrom !== undefined) {
    if (typeof page.excludeFrom !== 'string' || page.excludeFrom.length === 0 || page.excludeFrom.length > 128) {
      return { status: 'invalid', reason: 'Invalid sender-exclusion filter.' };
    }
    excludeFromMatch = agentRefAddressMatcher(page.excludeFrom, read.registry, labelIdentityOf(read.registry));
  }
  const messages: ChannelReadMessage[] = [];
  let matched = 0;
  let cursor = after;
  scan: for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: options.now });
    if (result.status !== 'ok') {
      return { status: result.status === 'retryable' ? 'retryable' : result.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    for (const row of result.messages) {
      const envelope = row.envelope, body = envelope.body;
      const accepted = !isGroupPresenceBody(body) && envelope.to.startsWith(prefix) &&
        (exact === undefined || envelope.to === exact) &&
        (idFilter === undefined || envelope.id === idFilter) &&
        (fromMatch === undefined || fromMatch(envelope.from)) &&
        (excludeFromMatch === undefined || !excludeFromMatch(envelope.from)) &&
        (thread === undefined || busBodyThread(body) === thread) &&
        (priority === undefined || envelope.priority === priority) &&
        (job === undefined || busBodyJobMatch(body, job)) &&
        (inReplyTo === undefined || busBodyInReplyToMatch(body, inReplyTo)) &&
        (since === undefined || row.receivedAt >= since) &&
        (before === undefined || row.receivedAt < before) &&
        (bodyKindFilter === undefined || busBodyKind(body) === bodyKindFilter) &&
        (resultOutcome === undefined || busBodyResultOutcome(body) === resultOutcome) &&
        (containsNeedle === undefined || busReadContainsMatch(body, containsNeedle));
      if (accepted) {
        matched += 1;
        if (!countMatched || messages.length < limit) {
          messages.push({ cursor: row.cursor, receivedAt: row.receivedAt, priority: envelope.priority,
            topic: envelope.to.slice(prefix.length),
            fromAgent: resolveAgent(read.registry, envelope.from)?.handle ?? null, envelope });
        }
      }
      if (!countMatched && messages.length === limit) { cursor = row.cursor; break scan; }
    }
    if (result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  annotateLiveEvidence(messages, options);
  return { status: 'ok', channel: name, messages, nextCursor: cursor,
    ...(countMatched ? { matched } : {}) };
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
/**
 * The live work-feed state behind a feed-citing body's own `jobId`
 * citation — the same projection `work feed` serves, joined with
 * live claim coverage. `feed:'ok'` with `job:null` means the feed is
 * healthy but projects no live job with the id — an orphaned status whose
 * announcement expired, never a guessed state. `refused` names the feed
 * refusal and its receipt when one caused it; the remaining states mean
 * the feed could not be read, so the job's state is unknown, never empty.
 */
export type BusEnvelopeLookupJob =
  | { jobId: string; feed: 'ok'; job: BusWorkFeedJob | null }
  | { jobId: string; feed: 'refused';
      reason: Extract<BusWorkFeedReadResult, { status: 'refused' }>['reason'];
      receipt?: Extract<BusWorkFeedReadResult, { status: 'refused' }>['receipt'] }
  | { jobId: string; feed: 'unavailable' | 'retryable' | 'invalid' };

export type BusEnvelopeLookup =
  | { status: 'ok'; id: string; message: BusEnvelopeLookupMessage;
      /**
       * Present only when the resolved body names a job (`jobId` on a
       * feed-citing body, `taskId` on a `worker-handoff`): the live feed
       * state of the job it cites, so the citation `work feed` and
       * `work mine` print resolves to where the job stands — status, claim
       * coverage and the receipts behind it — without a second read.
       */
      job?: BusEnvelopeLookupJob;
      /**
       * Present only when the body is claimable work or a worker handoff:
       * whether a taken message-id claim or a live coordination hold provably
       * covers the envelope — the same rule `work mine` next/handoffs and the
       * unified comms inbox apply. `held` false is proof of free; null means
       * a hold store could not be read (unknown, never proven free).
       */
      held?: boolean | null;
      /** Owner label of the blocking claim when held and known; null otherwise. */
      holder?: string | null;
      /**
       * Present only when `id` named a claim-holder wake hint (`wh-…`)
       * rather than an envelope id: `message` then carries the live
       * terminal `work.status` receipt the hint cites
       * (`message.envelope.id` equals `statusId`), `to` is the holder
       * label the hint was addressed to, and the rest names the job and
       * terminal status that holder was woken about.
       */
      wakeHint?: { to: string; statusId: string; jobId: string;
        status: WorkJob['status']; detail?: string } }
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
 * The retained v2 body kinds whose `jobId` is a feed citation: `work.post`,
 * `work.status` and `work.result` require it, `wake` declares it optional.
 * `work.claim`/`work.release` name jobs or keys too, but they execute as
 * claim operations rather than appending as mail, so their `jobId` is an
 * operation parameter, not a citation — and every other body kind cites
 * nothing and annotates nothing.
 */
const WORK_FEED_JOB_ID_KINDS: ReadonlySet<string> = new Set(['work.post', 'work.status', 'work.result', 'wake']);

/**
 * The `jobId` a feed-citing body carries through the same field the feed
 * projection keys on, read verbatim. The `jobId` must be a printable label
 * like the schema requires; a malformed one cites nothing.
 */
export function workFeedJobId(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record['kind'] !== 'string' || !WORK_FEED_JOB_ID_KINDS.has(record['kind'])) return undefined;
  const jobId = record['jobId'];
  if (typeof jobId !== 'string' || !THREAD.test(jobId)) return undefined;
  return jobId;
}

/**
 * The fleet job id a `worker-handoff` body assigns through `taskId` — the
 * same job-id namespace the feed's `jobId` uses: peer dispatch announces a
 * fleet job on `work.post` and can hand it off under the same id. Only the
 * receivable exact shape cites a job; every other body returns undefined.
 */
function workerHandoffJobId(body: unknown): string | undefined {
  return isWorkerHandoffBody(body) ? body.taskId : undefined;
}

/**
 * The job a retained body names: the `jobId` a feed-citing body declares,
 * or the fleet job id a `worker-handoff` assigns through `taskId`. The
 * `--job` inbox filter and every `job`/`jobState` annotation key on this
 * one citation, so a handoff for job X reads as mail about job X on every
 * surface — inbox and channel reads, `agents bus show`, wake referents,
 * `phm messages` and `work mine` claim messages alike.
 */
export function busBodyJobId(body: unknown): string | undefined {
  return workFeedJobId(body) ?? workerHandoffJobId(body);
}

/**
 * Every job id a retained body names under the `busBodyJobMatch` citation
 * rule — the feed `jobId`/`taskId` citation `busBodyJobId` reads plus the
 * `job:<id>` v2 thread bucket `busBodyThread` reads — sorted and deduplicated.
 * `busBodyJobMatch(body, job)` is true exactly when `job` is in this set (for
 * every non-empty job id), so item-level annotations that carry `jobIds` and
 * the per-body `--job` filters key on the same citations and can never
 * disagree. Today a body cites at most one job — the citation kinds are
 * disjoint — but the set form keeps multi-citation bodies honest if the rule
 * ever widens.
 */
export function busBodyJobIds(body: unknown): string[] {
  const ids = new Set<string>();
  const jobId = busBodyJobId(body);
  if (jobId !== undefined) ids.add(jobId);
  const thread = busBodyThread(body);
  if (thread !== null && thread.startsWith('job:') && thread.length > 'job:'.length) {
    ids.add(thread.slice('job:'.length));
  }
  return [...ids].sort();
}

/**
 * The `BusEnvelopeLookupJob` one already-read feed result produces for a
 * cited `jobId` — shared by the per-envelope `show` lookup and the inbox
 * page annotation so both resolve a citation identically. An `ok` feed
 * reports the projected job or null when none is live (an orphaned status
 * whose announcement expired); `refused` keeps the refusal and its receipt;
 * the remaining states mean the feed could not be read, so the job's state
 * is unknown, never empty.
 */
export function jobAnnotationFromFeed(feed: BusWorkFeedReadResult, jobId: string): BusEnvelopeLookupJob {
  if (feed.status === 'ok') {
    return { jobId, feed: 'ok', job: feed.jobs.find(candidate => candidate.id === jobId) ?? null };
  }
  if (feed.status === 'refused') {
    return { jobId, feed: 'refused', reason: feed.reason,
      ...(feed.receipt === undefined ? {} : { receipt: feed.receipt }) };
  }
  return { jobId, feed: feed.status };
}

/**
 * The live evidence a page of bus receipts carries, shared by `agents bus
 * inbox`, `agents bus channel read` and the `fleet bus-thread` live-evidence
 * read so every surface resolves the same rows
 * identically: claimable work and worker-handoff bodies get `held`/`holder`
 * — whether a taken message-id claim or a live coordination hold provably
 * covers the exact receipt, the same evidence `bus show` reports — and
 * bodies that name a job (`work.post`, `work.status`, `work.result` or
 * `wake` declaring a `jobId`, or a `worker-handoff` assigning its fleet
 * job id through `taskId`) get `job`, the live feed state of the job they
 * cite. Each
 * store is read at most once per page and only when a candidate is
 * present; a store that cannot be read degrades the annotation to
 * unknown, never to free or empty. Mutates the page rows in place.
 */
export function annotateLiveEvidence<T extends { cursor: number; receivedAt: number; envelope: BusEnvelope;
    held?: boolean | null; holder?: string | null; job?: BusEnvelopeLookupJob }>(
  messages: T[], options: UnifiedBusOptions): void {
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
  const jobCitations = new Map<T, string>();
  for (const message of messages) {
    const jobId = busBodyJobId(message.envelope.body);
    if (jobId !== undefined) jobCitations.set(message, jobId);
  }
  if (jobCitations.size === 0) return;
  let feed: BusWorkFeedReadResult | undefined;
  try { feed = readBusWorkFeed({ root: options.root, now: options.now, claims: true }); }
  catch { feed = undefined; }
  for (const [message, jobId] of jobCitations) {
    message.job = feed === undefined ? { jobId, feed: 'unavailable' } : jobAnnotationFromFeed(feed, jobId);
  }
}

/**
 * The work-feed state a job-citing body names — the `jobId` a feed-citing
 * body (`work.post`, `work.status`, `work.result` or `wake`) declares, or
 * the fleet job id a `worker-handoff` assigns through `taskId`, read
 * verbatim through `busBodyJobId`, so every other body kind returns
 * undefined and no job state is ever guessed from text. The feed read joins
 * live claim coverage, so an open job also
 * answers `claimable` — degraded to null, never free, when a hold store
 * cannot be read. A feed that cannot be read reports its own state; the
 * envelope lookup itself still succeeds.
 */
function envelopeWorkJob(body: unknown, options: UnifiedBusOptions): BusEnvelopeLookupJob | undefined {
  const jobId = busBodyJobId(body);
  if (jobId === undefined) return undefined;
  let feed: BusWorkFeedReadResult;
  try { feed = readBusWorkFeed({ root: options.root, now: options.now, claims: true }); }
  catch { return { jobId, feed: 'unavailable' }; }
  return jobAnnotationFromFeed(feed, jobId);
}

/**
 * The bounded page walk behind `readBusEnvelopeById`: one live envelope by
 * wire id, or the honest miss. It never interprets `wh-…` hint ids — the
 * caller decides whether a miss falls through to wake-queue resolution.
 */
function findBusEnvelopeById(id: string, options: UnifiedBusOptions): BusEnvelopeLookup {
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
        const job = envelopeWorkJob(row.envelope.body, options);
        return { status: 'ok', id, message, ...(hold ?? {}), ...(job === undefined ? {} : { job }) };
      }
    }
    if (result.messages.length < BUS_INBOX_MAX_READ || result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  return { status: 'not-found', id };
}

/**
 * Resolve a `wh-…` claim-holder wake-hint id to the terminal
 * `work.status` receipt that generated it — the same re-derivation
 * `agents bus wakes` annotates as `claimHolder`. The retained hint row
 * names the holder label the id hashed, and `claimHolderWakeContexts`
 * re-hashes every live terminal status receipt under that label. An
 * unreadable wake queue or bus store is `unavailable`; a hint with no
 * retained row, or whose citation no live receipt reproduces, is
 * `not-found` — never a guessed receipt. The queue's bounded tail means a
 * compacted hint reads the same as an expired one.
 */
function findClaimHolderWakeHint(id: string, options: UnifiedBusOptions): BusEnvelopeLookup {
  const wakes = readBusWakes({ root: options.runsRoot, match: row => row.id === id });
  if (wakes.state === 'unreadable') return { status: 'unavailable', reason: 'Wake queue is unreadable.' };
  const row = wakes.wakes.find(wake => wake.id === id);
  if (row === undefined) return { status: 'not-found', id };
  const context = claimHolderWakeContexts([row], options).get(id);
  if (context === 'unknown') return { status: 'unavailable', reason: 'Bus store is not readable.' };
  if (context === undefined || context === 'unresolved') return { status: 'not-found', id };
  const resolved = findBusEnvelopeById(context.statusId, options);
  if (resolved.status !== 'ok') return resolved.status === 'not-found' ? { status: 'not-found', id } : resolved;
  return { ...resolved, id, wakeHint: { to: row.to, statusId: context.statusId, jobId: context.jobId,
    status: context.status, ...(context.detail === undefined ? {} : { detail: context.detail }) } };
}

/**
 * Resolve one retained envelope by its wire id — the key wake hints, claim
 * operations, `work mine` items and dedupe all cite — or one claim-holder
 * wake-hint id (`wh-…`), which resolves through the wake queue to the
 * terminal `work.status` receipt that cites it. The scan is the same
 * bounded page walk the other reads use and sees only live (unexpired)
 * receipts: an expired or reclaimed-away id reports `not-found`, never a
 * stale row. Reading needs no identity and no addressing scope: like
 * `readAgentChannel`, the store is shared and ids are routing data, not
 * secrets. `fromAgent` decoration is best-effort; an unreadable registry
 * never hides the envelope itself. Claimable work and worker-handoff bodies
 * additionally report `held`/`holder` — whether a taken claim or live
 * coordination hold already covers the envelope, the same evidence `work
 * mine` next/handoffs and the unified comms inbox show. A body that
 * names a job (`work.post`, `work.status`, `work.result` or `wake`
 * declaring a `jobId`, or a `worker-handoff` assigning its fleet job id
 * through `taskId`) additionally reports `job` — the live work-feed state
 * of the job it cites, with claim coverage, or the feed's own refusal /
 * unavailable state when the projection cannot answer; the lookup still
 * succeeds either way. Envelope ids are
 * caller-chosen printable tokens, so a real receipt always wins over hint
 * interpretation; only a proven miss on a `wh-…` shape falls through.
 */
export function readBusEnvelopeById(id: string, options: UnifiedBusOptions = {}): BusEnvelopeLookup {
  if (typeof id !== 'string' || !THREAD.test(id)) {
    return { status: 'invalid', reason: 'Invalid message id.' };
  }
  const direct = findBusEnvelopeById(id, options);
  if (direct.status !== 'not-found' || !CLAIM_HOLDER_WAKE_ID.test(id)) return direct;
  return findClaimHolderWakeHint(id, options);
}
