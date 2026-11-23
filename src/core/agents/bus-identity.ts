/**
 * RQ-BUS-UNIFY-1: one stable identity per agent across providers and models.
 *
 * The registry lives beside the one durable bus store (`<root>/bus-inbox`,
 * default `$ASHLR_HOME/fleet`) in `<root>/agent-identities/registry.json`, so a
 * test or alternate root moves the identities with the messages. It is not a
 * second bus: it only maps names to routing labels that the existing
 * `appendBusInbox` envelope already carries.
 *
 * Identities are routing metadata, never authentication. Registering a handle
 * grants no tool, spend, send or execution authority; every consumer must keep
 * its existing admission checks. The stable id is derived from the handle
 * alone, so the same handle names the same agent on every node and every time
 * it changes provider or model.
 */
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ashlrHome } from '../cloud/store.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { providerSchema, type PROVIDERS } from './bus-v2-schema.js';

export const AGENT_REGISTRY_VERSION = 1;
export const AGENT_REGISTRY_MAX_BYTES = 256 * 1024;
export const AGENT_REGISTRY_MAX_IDENTITIES = 256;
export const AGENT_REGISTRY_MAX_CHANNELS = 64;
export const AGENT_MAX_ALIASES = 16;
export const AGENT_MAX_RUNTIMES = 16;
export const CHANNEL_MAX_MEMBERS = 64;
/** DM routing label prefix. `agent:<handle>` is the address every adapter writes to. */
export const AGENT_ADDRESS_PREFIX = 'agent:';
/** Prefixes owned by the unified bus; an alias may never shadow them, and a
 *  label-addressed post may never claim one — each has a dedicated verb. */
export const RESERVED_PREFIXES = ['agent:', 'group:', 'dm:', 'handoff:'];

/** The CLIs that have a session adapter (src/core/agents/bus-cli-adapters.ts). */
export const BUS_CLIS = ['claude', 'codex', 'devin', 'cursor', 'grok'] as const;
export type BusCli = typeof BUS_CLIS[number];
export type BusProvider = typeof PROVIDERS[number];

const credentialFree = (value: string): boolean => scrubSecrets(value) === value;
/** Same shape as the agentnet callsign: lowercase, starts with a letter, 1-32 chars. */
export const agentHandleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}(?![\s\S])/, 'handle: a-z, 0-9, -; 1-32 chars')
  .refine(credentialFree, 'credential-shaped handle');
/** Channel names reuse the bus-group room rule so `group:<name>:<topic>` stays valid. */
export const agentChannelNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}(?![\s\S])/, 'channel: a-z, 0-9, _ -; 1-32 chars');
const aliasSchema = z.string().regex(/^[\x21-\x7e]{1,128}(?![\s\S])/, 'printable ASCII label, 1-128 chars')
  .refine(credentialFree, 'credential-shaped alias')
  .refine(value => !RESERVED_PREFIXES.some(prefix => value.toLowerCase().startsWith(prefix)), 'reserved alias prefix');
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?![\s\S])/, 'model label')
  .refine(credentialFree, 'credential-shaped model');
const epochMs = z.number().int().nonnegative().safe();

export const agentRuntimeSchema = z.object({
  cli: z.enum(BUS_CLIS),
  provider: providerSchema,
  /** Model label as the CLI reports it; null when the CLI default is in use. */
  model: modelSchema.nullable(),
  lastSeenAt: epochMs,
}).strict();
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

export const agentIdentitySchema = z.object({
  id: z.string().regex(/^agt_[a-f0-9]{20}(?![\s\S])/),
  handle: agentHandleSchema,
  displayName: z.string().trim().min(1).max(128).refine(credentialFree),
  /** Legacy routing labels (lane names, v2 participantIds) this agent also answers to. */
  aliases: z.array(aliasSchema).max(AGENT_MAX_ALIASES),
  /** Every provider and model this identity has run on; one identity, many runtimes. */
  runtimes: z.array(agentRuntimeSchema).max(AGENT_MAX_RUNTIMES),
  createdAt: epochMs,
}).strict();
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export const agentChannelSchema = z.object({
  name: agentChannelNameSchema,
  members: z.array(agentHandleSchema).max(CHANNEL_MAX_MEMBERS),
  createdBy: agentHandleSchema,
  createdAt: epochMs,
}).strict();
export type AgentChannel = z.infer<typeof agentChannelSchema>;

export const agentRegistrySchema = z.object({
  version: z.literal(AGENT_REGISTRY_VERSION),
  identities: z.array(agentIdentitySchema).max(AGENT_REGISTRY_MAX_IDENTITIES),
  channels: z.array(agentChannelSchema).max(AGENT_REGISTRY_MAX_CHANNELS),
}).strict();
export type AgentRegistry = z.infer<typeof agentRegistrySchema>;

export interface AgentRegistryOptions {
  /** Same root as BusInboxOptions.root; default `$ASHLR_HOME/fleet`. */
  root?: string;
  now?: () => number;
}

export type RegistryFailure = {
  status: 'invalid' | 'conflict' | 'full' | 'not-found' | 'unavailable' | 'retryable';
  reason: string;
};
export type RegistryRead = { status: 'ok'; source: 'missing' | 'available'; registry: AgentRegistry } |
  { status: 'unavailable'; reason: string };

const fail = (status: RegistryFailure['status'], reason: string): RegistryFailure => ({ status, reason });

/** Deterministic: the handle alone fixes the id, on every node and across model changes. */
export function stableAgentId(handle: string): string {
  agentHandleSchema.parse(handle);
  return `agt_${createHash('sha256').update(`phantom-agent-identity.v1\0${handle}`).digest('hex').slice(0, 20)}`;
}

export function agentAddress(handle: string): string {
  agentHandleSchema.parse(handle);
  return `${AGENT_ADDRESS_PREFIX}${handle}`;
}

/** Resolve a handle, `agent:<handle>`, stable id or alias. Labels are matched exactly. */
export function resolveAgent(registry: AgentRegistry, ref: string): AgentIdentity | undefined {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) return undefined;
  const handle = ref.startsWith(AGENT_ADDRESS_PREFIX) ? ref.slice(AGENT_ADDRESS_PREFIX.length) : ref;
  return registry.identities.find(identity => identity.handle === handle) ??
    registry.identities.find(identity => identity.id === ref) ??
    registry.identities.find(identity => identity.aliases.includes(ref));
}

export function findAgentChannel(registry: AgentRegistry, name: string): AgentChannel | undefined {
  return registry.channels.find(channel => channel.name === name);
}

/** Every routing label a message to this identity may carry: the refs
 * `resolveAgent` accepts — its `agent:` address, bare handle, stable id and
 * aliases. Inbox and wake matching key on this set, so a foreign producer that
 * addresses the bare handle or `agt_` id still reaches the same agent. */
export function agentLabels(identity: AgentIdentity): string[] {
  return [`${AGENT_ADDRESS_PREFIX}${identity.handle}`, identity.handle, identity.id, ...identity.aliases];
}

function emptyRegistry(): AgentRegistry {
  return { version: AGENT_REGISTRY_VERSION, identities: [], channels: [] };
}

function rootPath(options: AgentRegistryOptions): string { return options.root ?? join(ashlrHome(), 'fleet'); }

function privatePath(path: string, kind: 'file' | 'directory', anchorPath: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o777) !== (kind === 'file' ? 0o600 : 0o700))) throw new Error('Unavailable');
  if (!assurePrivateStoragePath(path, kind, 'inspect-existing', { anchorPath }).ok) throw new Error('Unavailable');
}

function missing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw new Error('Unavailable'); }
}

/** Cross-record invariants zod cannot express: unique handles, aliases and members. */
function checkInvariants(registry: AgentRegistry): string | null {
  const handles = new Set<string>();
  const labels = new Set<string>();
  for (const identity of registry.identities) {
    if (handles.has(identity.handle)) return 'duplicate handle';
    handles.add(identity.handle);
    if (identity.id !== stableAgentId(identity.handle)) return 'identity id does not match its handle';
    for (const alias of identity.aliases) {
      if (labels.has(alias)) return 'alias bound to more than one identity';
      labels.add(alias);
    }
    const runtimes = new Set(identity.runtimes.map(runtime => `${runtime.cli}\0${runtime.provider}\0${runtime.model ?? ''}`));
    if (runtimes.size !== identity.runtimes.length) return 'duplicate runtime';
  }
  for (const alias of labels) if (handles.has(alias)) return 'alias shadows a handle';
  const names = new Set<string>();
  for (const channel of registry.channels) {
    if (names.has(channel.name)) return 'duplicate channel';
    names.add(channel.name);
    if (new Set(channel.members).size !== channel.members.length) return 'duplicate channel member';
    if (channel.members.some(member => !handles.has(member))) return 'channel member is not registered';
  }
  return null;
}

function load(root: string): { source: 'missing' | 'available'; registry: AgentRegistry } {
  const directory = join(root, 'agent-identities'), file = join(directory, 'registry.json');
  if (missing(root)) return { source: 'missing', registry: emptyRegistry() };
  privatePath(root, 'directory', root);
  if (missing(directory)) return { source: 'missing', registry: emptyRegistry() };
  privatePath(directory, 'directory', root);
  if (missing(file)) return { source: 'missing', registry: emptyRegistry() };
  privatePath(file, 'file', root);
  const read = readStableRegularFile(file, { anchorPath: root, maxFileBytes: AGENT_REGISTRY_MAX_BYTES, remainingBytes: AGENT_REGISTRY_MAX_BYTES });
  if (!read.ok) throw new Error('Unavailable');
  const parsed = agentRegistrySchema.safeParse(JSON.parse(read.text));
  if (!parsed.success || checkInvariants(parsed.data)) throw new Error('Unavailable');
  return { source: 'available', registry: parsed.data };
}

/** Read-only; never creates the store. A damaged file is unavailable, never silently empty. */
export function readAgentRegistry(options: AgentRegistryOptions = {}): RegistryRead {
  try { return { status: 'ok', ...load(rootPath(options)) }; }
  catch { return { status: 'unavailable', reason: 'Agent identity registry is unreadable.' }; }
}

/** Maps one routing label to the stable id of the identity it proves, or undefined. */
export type AgentIdentityKeyFor = (label: string) => string | undefined;

/** The memoized label→identity-key lookup bound to one already-read registry. */
function identityKeysFor(registry: AgentRegistry): AgentIdentityKeyFor {
  const keys = new Map<string, string | undefined>();
  return (label) => {
    if (!keys.has(label)) {
      const identity = resolveAgent(registry, label) ?? resolveAgent(registry, label.toLowerCase());
      keys.set(label, identity?.id);
    }
    return keys.get(label);
  };
}

/**
 * One registry read shared by every label a read filter compares: a label
 * resolves to its identity's stable id through handle, `agent:` address, id or
 * alias (exact match first, then lowercase so `Devin` still finds handle
 * `devin`). Undefined when the registry cannot be read, so callers keep strict
 * label matching — an unreadable registry never widens a filter.
 */
export function agentIdentityKeys(options: AgentRegistryOptions = {}): AgentIdentityKeyFor | undefined {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') return undefined;
  return identityKeysFor(read.registry);
}

/**
 * One address filter as a predicate over envelope routing labels: the literal
 * label, or any other label of the same registered identity when `label`
 * resolves through `identityOf` — a filter naming `agent:<handle>` also
 * matches the bare handle, stable id and aliases. A label that resolves to no
 * identity, and an unreadable registry (`identityOf` undefined), keep
 * exact-label matching: unknown identity state never widens a filter.
 */
export function agentAddressMatcher(identityOf: AgentIdentityKeyFor | undefined, label: string): (value: string) => boolean {
  const key = identityOf?.(label);
  if (key === undefined) return value => value === label;
  return value => value === label || identityOf?.(value) === key;
}

/**
 * "Addressed to this agent" for the pending-work surfaces — `bus next` claims
 * and the `work mine` digest's next/handoffs sections: the literal `ref`, any
 * label of the identity it resolves to, or a `group:<channel>:<topic>` address
 * of a registry channel that identity belongs to — minus channel posts the
 * identity sent itself, the same membership rule the inbox, wake and channel
 * reads apply. `registry` undefined (unreadable) or a `ref` resolving to no
 * identity contributes no channels and no labels beyond the literal `ref`, so
 * matching never widens on unknown state. The predicate takes an envelope's
 * `to` and `from` routing labels.
 */
export function agentPendingAddressMatcher(ref: string, registry: AgentRegistry | undefined): (to: string, from: string) => boolean {
  const identity = registry === undefined ? undefined : resolveAgent(registry, ref);
  const identityOf = registry === undefined ? undefined : identityKeysFor(registry);
  // `ref` is an agent ref, so it resolves through `resolveAgent` exactly like
  // the inbox, wake, channel and work-mine identity reads: a case-variant or
  // otherwise unregistered spelling resolves to no identity and keeps
  // exact-label matching only. The lowercase fallback `identityKeysFor`
  // carries belongs to the envelope `to` labels on the right of the compare —
  // a `Devin`-stamped recipient still reaches handle `devin` — never to the
  // agent ref, which would otherwise inherit one identity's label matching
  // while missing its channel membership.
  const key = identity?.id;
  const selfLabels = new Set(identity === undefined ? [] : agentLabels(identity));
  const prefixes = registry === undefined || identity === undefined ? [] : registry.channels
    .filter(channel => channel.members.includes(identity.handle))
    .map(channel => `group:${channel.name}:`);
  return (to, from) => to === ref || (key !== undefined && identityOf?.(to) === key) ||
    (prefixes.length > 0 && !selfLabels.has(from) && prefixes.some(prefix => to.startsWith(prefix)));
}

type Mutation<T> = (registry: AgentRegistry, now: number) => RegistryFailure | { registry: AgentRegistry; value: T; changed: boolean };

/** Lock, reload, apply, validate, atomically replace. Nothing is written on refusal. */
function mutate<T>(options: AgentRegistryOptions, apply: Mutation<T>): RegistryFailure | { status: 'ok'; value: T; changed: boolean } {
  let now: number;
  try { now = (options.now ?? Date.now)(); } catch { return fail('invalid', 'Clock is unavailable.'); }
  if (!Number.isSafeInteger(now) || now < 0) return fail('invalid', 'Clock is invalid.');
  try {
    const root = rootPath(options), directory = join(root, 'agent-identities');
    if (!options.root) { ensurePrivateDirectory(ashlrHome()); privatePath(ashlrHome(), 'directory', ashlrHome()); }
    ensurePrivateDirectory(root); privatePath(root, 'directory', root);
    ensurePrivateDirectory(directory); privatePath(directory, 'directory', root);
    const acquired = acquireLocalStoreLockWithOutcome(join(directory, 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (acquired.state !== 'acquired') {
      return fail(acquired.state === 'contended' ? 'retryable' : 'unavailable', 'Agent identity registry is busy.');
    }
    try {
      const current = load(root).registry;
      const result = apply(structuredClone(current), now);
      if ('status' in result) return result;
      if (!result.changed) return { status: 'ok', value: result.value, changed: false };
      const checked = agentRegistrySchema.safeParse(result.registry);
      if (!checked.success) return fail('full', 'Agent identity registry limits reached.');
      const problem = checkInvariants(checked.data);
      if (problem) return fail('conflict', `Refused: ${problem}.`);
      const json = JSON.stringify(checked.data);
      if (Buffer.byteLength(json) > AGENT_REGISTRY_MAX_BYTES) return fail('full', 'Agent identity registry is full.');
      writePrivateFileAtomically(join(directory, '.pending'), join(directory, 'registry.json'), json, { anchorPath: root, label: 'Agent identity registry' });
      return { status: 'ok', value: result.value, changed: true };
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { return fail('unavailable', 'Agent identity registry is unavailable.'); }
}

export interface RegisterAgentInput {
  handle: string;
  displayName?: string;
  aliases?: readonly string[];
  runtime?: { cli: BusCli; provider: BusProvider; model?: string | null };
}
export type RegisterAgentResult = RegistryFailure |
  { status: 'created' | 'updated' | 'unchanged'; identity: AgentIdentity };

/**
 * Upsert. The id never changes; new aliases and runtimes are merged in, and a
 * runtime seen again only refreshes `lastSeenAt`. When the runtime list is full
 * the least recently seen runtime is dropped, never the identity.
 */
export function registerAgentIdentity(input: RegisterAgentInput, options: AgentRegistryOptions = {}): RegisterAgentResult {
  const handle = agentHandleSchema.safeParse(input?.handle);
  if (!handle.success) return fail('invalid', 'Handle must be 1-32 chars of a-z, 0-9 and -, starting with a letter.');
  const aliases = z.array(aliasSchema).max(AGENT_MAX_ALIASES).safeParse(input.aliases ?? []);
  if (!aliases.success) return fail('invalid', 'Aliases must be printable routing labels without reserved prefixes.');
  const displayName = input.displayName === undefined ? undefined
    : z.string().trim().min(1).max(128).refine(credentialFree).safeParse(input.displayName);
  if (displayName && !displayName.success) return fail('invalid', 'Display name must be 1-128 characters.');
  let runtime: Omit<AgentRuntime, 'lastSeenAt'> | undefined;
  if (input.runtime) {
    const parsed = agentRuntimeSchema.omit({ lastSeenAt: true })
      .safeParse({ cli: input.runtime.cli, provider: input.runtime.provider, model: input.runtime.model ?? null });
    if (!parsed.success) return fail('invalid', 'Runtime needs a known cli, provider and an optional model label.');
    runtime = parsed.data;
  }
  const result = mutate<{ identity: AgentIdentity; created: boolean }>(options, (registry, now) => {
    for (const alias of aliases.data) {
      const owner = resolveAgent(registry, alias);
      if (owner && owner.handle !== handle.data) return fail('conflict', 'Alias already belongs to another identity.');
      if (registry.identities.some(identity => identity.handle === alias)) return fail('conflict', 'Alias shadows a handle.');
    }
    let identity = registry.identities.find(candidate => candidate.handle === handle.data);
    const created = !identity;
    if (!identity) {
      if (registry.identities.some(candidate => candidate.aliases.includes(handle.data))) {
        return fail('conflict', 'Handle is already an alias of another identity.');
      }
      if (registry.identities.length >= AGENT_REGISTRY_MAX_IDENTITIES) return fail('full', 'Identity limit reached.');
      identity = { id: stableAgentId(handle.data), handle: handle.data, displayName: displayName?.data ?? handle.data,
        aliases: [], runtimes: [], createdAt: now };
      registry.identities.push(identity);
    }
    const before = JSON.stringify(identity);
    if (displayName?.data !== undefined) identity.displayName = displayName.data;
    for (const alias of aliases.data) if (!identity.aliases.includes(alias)) identity.aliases.push(alias);
    if (identity.aliases.length > AGENT_MAX_ALIASES) return fail('full', 'Alias limit reached for this identity.');
    if (runtime) {
      const seen = identity.runtimes.find(row => row.cli === runtime!.cli && row.provider === runtime!.provider && row.model === runtime!.model);
      if (seen) seen.lastSeenAt = now;
      else {
        identity.runtimes.push({ ...runtime, lastSeenAt: now });
        if (identity.runtimes.length > AGENT_MAX_RUNTIMES) {
          identity.runtimes.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
          identity.runtimes.length = AGENT_MAX_RUNTIMES;
        }
      }
    }
    const changed = created || JSON.stringify(identity) !== before;
    return { registry, value: { identity, created }, changed };
  });
  if (result.status !== 'ok') return result;
  return { status: result.value.created ? 'created' : result.changed ? 'updated' : 'unchanged', identity: result.value.identity };
}

export type ChannelResult = RegistryFailure | { status: 'created' | 'updated' | 'unchanged'; channel: AgentChannel };

/** Create a channel; the creator is always a member. Re-creating with the same creator merges members. */
export function createAgentChannel(input: { name: string; createdBy: string; members?: readonly string[] },
  options: AgentRegistryOptions = {}): ChannelResult {
  const name = agentChannelNameSchema.safeParse(input?.name);
  if (!name.success) return fail('invalid', 'Channel name must be 1-32 chars of a-z, 0-9, _ and -.');
  return channelMutation(options, (registry, now) => {
    const creator = resolveAgent(registry, input.createdBy);
    if (!creator) return fail('not-found', 'Creator is not a registered identity.');
    const members: string[] = [creator.handle];
    for (const ref of input.members ?? []) {
      const member = resolveAgent(registry, ref);
      if (!member) return fail('not-found', 'Channel member is not a registered identity.');
      if (!members.includes(member.handle)) members.push(member.handle);
    }
    let channel = findAgentChannel(registry, name.data);
    if (channel && channel.createdBy !== creator.handle) return fail('conflict', 'Channel already exists.');
    const created = !channel;
    if (!channel) {
      if (registry.channels.length >= AGENT_REGISTRY_MAX_CHANNELS) return fail('full', 'Channel limit reached.');
      channel = { name: name.data, members: [], createdBy: creator.handle, createdAt: now };
      registry.channels.push(channel);
    }
    const before = channel.members.length;
    for (const member of members) if (!channel.members.includes(member)) channel.members.push(member);
    if (channel.members.length > CHANNEL_MAX_MEMBERS) return fail('full', 'Channel member limit reached.');
    return { registry, value: { channel, created }, changed: created || channel.members.length !== before };
  });
}

export function joinAgentChannel(name: string, agent: string, options: AgentRegistryOptions = {}): ChannelResult {
  return membership(name, agent, 'join', options);
}

export function leaveAgentChannel(name: string, agent: string, options: AgentRegistryOptions = {}): ChannelResult {
  return membership(name, agent, 'leave', options);
}

function membership(name: string, agent: string, op: 'join' | 'leave', options: AgentRegistryOptions): ChannelResult {
  if (!agentChannelNameSchema.safeParse(name).success) return fail('invalid', 'Invalid channel name.');
  return channelMutation(options, registry => {
    const channel = findAgentChannel(registry, name);
    if (!channel) return fail('not-found', 'Channel does not exist.');
    const identity = resolveAgent(registry, agent);
    if (!identity) return fail('not-found', 'Agent is not a registered identity.');
    const has = channel.members.includes(identity.handle);
    if (op === 'join' && !has) {
      if (channel.members.length >= CHANNEL_MAX_MEMBERS) return fail('full', 'Channel member limit reached.');
      channel.members.push(identity.handle);
    }
    if (op === 'leave' && has) channel.members = channel.members.filter(member => member !== identity.handle);
    return { registry, value: { channel, created: false }, changed: op === 'join' ? !has : has };
  });
}

function channelMutation(options: AgentRegistryOptions,
  apply: Mutation<{ channel: AgentChannel; created: boolean }>): ChannelResult {
  const result = mutate(options, apply);
  if (result.status !== 'ok') return result;
  return { status: result.value.created ? 'created' : result.changed ? 'updated' : 'unchanged', channel: result.value.channel };
}
