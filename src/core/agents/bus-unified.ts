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
 *   handoff  to `agent:<handle>`                channel `handoff`, body `worker-handoff`
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  type BusInboxOptions, type BusInboxPost } from '../fleet/bus-inbox.js';
import { BUS_PRIORITIES, type BusEnvelope, type BusPriority } from '../fleet/bus-envelope.js';
import { groupAddress } from '../fleet/bus-group.js';
import { createBusWakeHook, type BusWakeResult } from '../fleet/bus-wake.js';
import { busWakeQueueEnqueue, readBusWakes, type BusWakeRow } from '../fleet/bus-wake-queue.js';
import { isFleetJobId } from '../fleet/runs-job-detail.js';
import { scrubSecrets } from '../util/scrub.js';
import { localWriteGate } from './send-gate.js';
import { BUS_V2_TEXT_MAX } from './bus-v2-schema.js';
import {
  AGENT_ADDRESS_PREFIX, agentChannelNameSchema, agentLabels, findAgentChannel, readAgentRegistry, resolveAgent,
  type AgentIdentity, type AgentRegistry, type AgentRegistryOptions,
} from './bus-identity.js';

export const UNIFIED_BUS_ORIGIN = 'agent-bus';
export const DEFAULT_DM_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;
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
  | { status: 'posted' | 'duplicate'; id: string; cursor: number; to: string; wake: WakeOutcome }
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
  const latest = [...identity.runtimes].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  return latest?.provider ?? 'phantom';
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

function noteBody(input: { text: string; thread?: string; refs?: string[] }) {
  return {
    kind: 'note', text: input.text,
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
}
export type InboxPage = { status: 'ok'; agent: string; messages: InboxMessage[]; nextCursor: number } |
  { status: 'invalid' | 'unknown-agent' | 'unavailable' | 'retryable'; reason: string };

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
 * One page of an identity's inbox: DMs and handoffs to `agent:<handle>`,
 * traffic still addressed to its legacy aliases, and posts in its channels
 * (minus its own). Returned highest priority first; `nextCursor` covers every
 * scanned row, so callers persist it only after handling the page.
 */
export function readAgentInbox(ref: string, page: { after?: number; limit?: number } = {},
  options: UnifiedBusOptions = {}): InboxPage {
  const after = page.after ?? 0, limit = page.limit ?? 50;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > BUS_INBOX_MAX_READ) {
    return { status: 'invalid', reason: 'after must be >= 0 and limit 1-100.' };
  }
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const self = `${AGENT_ADDRESS_PREFIX}${target.identity.handle}`;
  const messages: InboxMessage[] = [];
  let cursor = after;
  scan: for (let index = 0; index < MAX_PAGES; index += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: options.root, now: options.now });
    if (result.status !== 'ok') {
      return { status: result.status === 'retryable' ? 'retryable' : result.status === 'invalid' ? 'invalid' : 'unavailable',
        reason: 'Bus store is not readable.' };
    }
    for (const row of result.messages) {
      const envelope = row.envelope;
      let kind: InboxKind | null = null;
      const channel = channelOf(envelope.to, target.channels);
      if (envelope.channel === 'handoff' && target.labels.has(envelope.to)) kind = 'handoff';
      else if (envelope.to === self) kind = 'dm';
      else if (target.labels.has(envelope.to)) kind = 'legacy';
      else if (channel && !target.labels.has(envelope.from)) kind = 'channel';
      if (kind) {
        messages.push({ cursor: row.cursor, receivedAt: row.receivedAt, kind, priority: envelope.priority,
          fromAgent: resolveAgent(read.registry, envelope.from)?.handle ?? null,
          channel: kind === 'channel' ? channel : null, envelope });
      }
      if (messages.length === limit) { cursor = row.cursor; break scan; }
    }
    if (result.nextCursor <= cursor) break;
    cursor = result.nextCursor;
  }
  messages.sort((a, b) => a.priority.localeCompare(b.priority) || a.cursor - b.cursor);
  return { status: 'ok', agent: target.identity.handle, messages, nextCursor: cursor };
}

export type WakePage = { status: 'ok'; agent: string; wakes: BusWakeRow[] } |
  { status: 'unknown-agent' | 'unavailable'; reason: string };

/**
 * Wake hints addressed to this identity (directly, by alias, or to one of its
 * channels) after `sinceAt`. A wake is only a hint to read the inbox: it
 * carries routing ids, never a body, and grants nothing.
 */
export function readAgentWakes(ref: string, sinceAt: number | undefined, options: UnifiedBusOptions = {}): WakePage {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return { status: 'unavailable', reason: read.reason };
  const target = addressing(read.registry, ref);
  if (!target) return { status: 'unknown-agent', reason: 'Agent is not a registered identity.' };
  const wakes = readBusWakes({ root: options.runsRoot, sinceAt });
  if (wakes.state === 'unreadable') return { status: 'unavailable', reason: 'Wake queue is unreadable.' };
  return { status: 'ok', agent: target.identity.handle, wakes: wakes.wakes.filter(wake =>
    target.labels.has(wake.to) || (channelOf(wake.to, target.channels) !== null && !target.labels.has(wake.from))) };
}
