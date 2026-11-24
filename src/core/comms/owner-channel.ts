/**
 * One adapter surface for the owner's channels. Every adapter is disabled
 * until its owner identity is configured. Remote credentials are Phantom
 * Secrets handle names, never values.
 */
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { realHome } from '../real-home.js';
import type { TeamIdentity } from '../agents/channel-policy.js';
import { parseCommsConfirmation, parseTeamIdentities } from '../agents/channel-policy.js';
import { parseMasonIdentities } from '../agents/leader-network.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  OWNER_CHANNELS,
  OWNER_THREAD_ID,
  isOwnerChannel,
  ownerChannelToBus,
  type OwnerChannel,
} from './leader-mailbox.js';

export const OWNER_SECRET_HANDLES = {
  telegram: 'phm_TELEGRAM_BOT_TOKEN',
  email: 'phm_EMAIL_CREDENTIAL',
  slack: 'phm_SLACK_BOT_TOKEN',
} as const;

export type OwnerSecretChannel = keyof typeof OWNER_SECRET_HANDLES;

/** Real owner config. `$HOME` and `ASHLR_CONFIG_DIR` cannot retarget this path. */
export function fixedOwnerConfigDir(): string {
  const home = realHome();
  return home ? join(home, '.ashlr') : join('/owner-home-unavailable');
}

/** Real runs directory. `$HOME` and `ASHLR_RUNS_DIR` cannot retarget email-drop. */
export function fixedOwnerRunsDir(): string {
  const home = realHome();
  return home ? join(home, '.ashlr-runs') : join('/owner-home-unavailable');
}

export interface OwnerInbound {
  idempotencyKey: string;
  senderId: string;
  text: string;
  at: number;
  channelRef?: string;
}

export interface OwnerDelivery {
  idempotencyKey: string;
  text: string;
  ownerId: string;
  channelRef?: string;
}

export interface OwnerChannelTransport {
  pull(): Promise<OwnerInbound[]>;
  deliver(input: OwnerDelivery): Promise<{ status: 'sent' | 'duplicate' | 'refused'; reason: string }>;
}

export interface OwnerThreadSettings {
  owners: Partial<Record<OwnerChannel, string>>;
  secretHandles: Partial<Record<OwnerSecretChannel, string>>;
  /** Only `loopback` enables iMessage. Anything else stays off. */
  imessageBridge: 'loopback' | 'off';
  confirmed: boolean;
  team: readonly TeamIdentity[];
}

export interface OwnerAdapterStatus {
  id: OwnerChannel;
  configured: boolean;
  enabled: boolean;
  halted: boolean;
  secretHandle: string | null;
  reason: string;
  nextStep: string | null;
}

export function emptyOwnerSettings(): OwnerThreadSettings {
  return { owners: {}, secretHandles: {}, imessageBridge: 'off', confirmed: false, team: [] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Names only. A value that is not the expected handle disables that adapter and is never returned. */
export function normalizeSecretHandle(channel: OwnerSecretChannel, value: unknown): string | undefined {
  return value === OWNER_SECRET_HANDLES[channel] ? OWNER_SECRET_HANDLES[channel] : undefined;
}

export function adapterStatus(channel: OwnerChannel, settings: OwnerThreadSettings, halted: boolean, paused: boolean): OwnerAdapterStatus {
  const ownerId = settings.owners[channel];
  const secretHandle = channel === 'telegram' || channel === 'email' || channel === 'slack'
    ? settings.secretHandles[channel] ?? null
    : null;
  let configured = Boolean(ownerId);
  let reason = configured ? 'Owner identity is configured.' : 'Disabled until an owner identity is configured.';
  const identityStep = `Add { channel = "${ownerChannelToBus(channel)}", id = "${channel === 'desktop' ? 'local-owner' : '<your id>'}" } to [mason] and [team] in ~/.ashlr/agent-network.toml.`;
  let nextStep: string | null = configured ? null : identityStep;
  if (channel === 'telegram' || channel === 'email' || channel === 'slack') {
    if (!secretHandle) {
      configured = false;
      reason = 'Disabled until the Phantom Secrets handle is named.';
      nextStep = `Name ${OWNER_SECRET_HANDLES[channel]} under [${channel}] secretHandle in ~/.ashlr/comms/owner-adapters.toml.`;
    } else if (!ownerId) {
      configured = false;
      reason = 'Disabled until an owner identity is configured.';
      nextStep = identityStep;
    } else {
      reason = 'Owner identity and secret handle are configured.';
    }
  }
  if (channel === 'imessage') {
    if (settings.imessageBridge !== 'loopback') {
      configured = false;
      reason = 'iMessage is loopback-only and stays disabled until the local bridge is selected.';
      nextStep = 'Set [imessage] bridge = "loopback" in ~/.ashlr/comms/owner-adapters.toml.';
    } else if (!ownerId) {
      configured = false;
      reason = 'Disabled until an owner identity is configured.';
      nextStep = identityStep;
    } else {
      reason = 'Loopback bridge and owner identity are configured.';
    }
  }
  if (channel === 'desktop' && ownerId) reason = 'Native desktop thread is configured.';
  const enabled = configured && !halted && !paused;
  if (halted) {
    reason = 'Kill switch halted this adapter.';
    nextStep = 'Remove ~/.ashlr/KILL or resume comms to deliver.';
  } else if (paused && configured) {
    reason = 'Communications are paused.';
    nextStep = 'Remove ~/.ashlr/KILL or resume comms to deliver.';
  }
  return { id: channel, configured, enabled, halted, secretHandle, reason, nextStep };
}

export function ownerAllowed(channel: OwnerChannel, senderId: string, settings: OwnerThreadSettings): boolean {
  return senderId.length > 0 && settings.owners[channel] === senderId;
}

export const NOTIFY_CHANNELS = ['imessage', 'email', 'desktop'] as const satisfies readonly OwnerChannel[];
export type NotifyChannel = typeof NOTIFY_CHANNELS[number];
export type NotifyUpdateType = 'decision' | 'approval' | 'digest' | 'incident' | 'merged' | 'status';
export type NotifyAvailability = 'available' | 'unavailable' | 'unknown';
type NotifyDelivery = 'now' | 'next-digest';
interface NotifyRule {
  readonly channel: NotifyChannel;
  readonly fallback: NotifyChannel;
  readonly delivery: NotifyDelivery;
  readonly fallbackDelivery: NotifyDelivery;
  readonly reason: string;
  readonly replyFormat: 'YES or NO' | null;
}

/** Policy only: these routes use the existing owner thread, never another outbox. */
export const NOTIFY_ROUTES = {
  decision: { channel: 'imessage', fallback: 'desktop', delivery: 'now', fallbackDelivery: 'now', reason: 'Decisions need a short owner reply.', replyFormat: 'YES or NO' },
  approval: { channel: 'imessage', fallback: 'desktop', delivery: 'now', fallbackDelivery: 'now', reason: 'Approvals need a short owner reply.', replyFormat: 'YES or NO' },
  digest: { channel: 'email', fallback: 'desktop', delivery: 'now', fallbackDelivery: 'now', reason: 'A prepared digest belongs in email.', replyFormat: null },
  incident: { channel: 'imessage', fallback: 'desktop', delivery: 'now', fallbackDelivery: 'now', reason: 'Incidents need prompt owner attention.', replyFormat: null },
  merged: { channel: 'email', fallback: 'desktop', delivery: 'next-digest', fallbackDelivery: 'next-digest', reason: 'Merged work joins the next digest.', replyFormat: null },
  status: { channel: 'desktop', fallback: 'email', delivery: 'now', fallbackDelivery: 'next-digest', reason: 'Live status belongs in the desktop app; email batches it.', replyFormat: null },
} as const satisfies Record<NotifyUpdateType, NotifyRule>;

export interface NotifyRoutePlan {
  schemaVersion: 'notify.route.v1';
  dryRun: true;
  sent: false;
  threadId: typeof OWNER_THREAD_ID;
  updateType: NotifyUpdateType;
  preferredChannel: NotifyChannel;
  channel: NotifyChannel | null;
  fallbackChannel: NotifyChannel;
  availability: NotifyAvailability;
  delivery: NotifyDelivery | 'blocked';
  wouldSendNow: boolean | 'unknown';
  reason: string;
  replyFormat: 'YES or NO' | null;
  verifiedSenderCheck: 'src/core/comms/owner-channel.ts#ownerAllowed';
}

/**
 * The one update router. Supplied availability is a scenario, not live health
 * or send/identity authority. `ruleChannel` is the owner's rule for this update
 * type (notify-rules.ts); omitted, the built-in route applies.
 */
export function planNotifyRoute(
  updateType: NotifyUpdateType,
  availability: Partial<Record<NotifyChannel, NotifyAvailability>> = {},
  ruleChannel?: NotifyChannel,
): NotifyRoutePlan {
  const base: NotifyRule = NOTIFY_ROUTES[updateType];
  const fallbackChannel: NotifyChannel = ruleChannel === 'desktop' ? 'email' : 'desktop';
  const rule: NotifyRule = !ruleChannel || ruleChannel === base.channel ? base : {
    ...base, channel: ruleChannel, fallback: fallbackChannel,
    fallbackDelivery: fallbackChannel === 'email' ? 'next-digest' : base.delivery,
    reason: `The rule sends this to ${ruleChannel}.`,
  };
  const fallback = availability[rule.channel] === 'unavailable';
  const candidate = fallback ? rule.fallback : rule.channel;
  const state = availability[candidate] ?? 'unknown';
  const channel = state === 'unavailable' ? null : candidate;
  const delivery = channel === null ? 'blocked' : fallback ? rule.fallbackDelivery : rule.delivery;
  const reason = [rule.reason,
    ...(fallback ? [`${rule.channel} is unavailable; fallback is ${rule.fallback}.`] : []),
    ...(channel === null ? ['Both channels are unavailable.'] : state === 'unknown' ? [`${channel} availability is unknown.`] : []),
  ].join(' ');
  // Explicit order is the versioned CLI JSON contract; no clock or config reads.
  return {
    schemaVersion: 'notify.route.v1', dryRun: true, sent: false, threadId: OWNER_THREAD_ID,
    updateType, preferredChannel: rule.channel, channel, fallbackChannel: rule.fallback,
    availability: state, delivery,
    wouldSendNow: delivery !== 'now' ? false : state === 'unknown' ? 'unknown' : true,
    reason, replyFormat: rule.replyFormat,
    verifiedSenderCheck: 'src/core/comms/owner-channel.ts#ownerAllowed',
  };
}

/** Reply destinations: the channel the owner used, then the desktop thread. */
export function fanoutChannels(origin: OwnerChannel): OwnerChannel[] {
  return origin === 'desktop' ? ['desktop'] : [origin, 'desktop'];
}

export function busIdentity(channel: OwnerChannel, ownerId: string): TeamIdentity {
  return { channel: ownerChannelToBus(channel), id: ownerId };
}

function readToml(directory: string, name: string): string {
  const result = readStableRegularFile(join(directory, name), {
    anchorPath: directory, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024,
  });
  return result.ok ? result.text : '';
}

/** Fail closed. Malformed files yield an empty allowlist and disabled adapters. */
export function loadOwnerThreadSettings(configDir: string): OwnerThreadSettings {
  const network = readToml(configDir, 'agent-network.toml');
  const owners: Partial<Record<OwnerChannel, string>> = {};
  for (const identity of parseMasonIdentities(network)) {
    if (identity.channel === 'bus') owners.desktop = identity.id;
    else if (isOwnerChannel(identity.channel)) owners[identity.channel] = identity.id;
  }
  // Pairing must resolve to one owner handle; never choose the last of several.
  if (new Set(parseMasonIdentities(network).filter(i => i.channel === 'imessage').map(i => i.id)).size !== 1) delete owners.imessage;
  let secretHandles: OwnerThreadSettings['secretHandles'] = {};
  let imessageBridge: OwnerThreadSettings['imessageBridge'] = 'off';
  try {
    const doc = parse(readToml(join(configDir, 'comms'), 'owner-adapters.toml'), { unsafeKeyBehaviour: 'throw' });
    for (const channel of Object.keys(OWNER_SECRET_HANDLES) as OwnerSecretChannel[]) {
      const section = doc[channel];
      if (!record(section)) continue;
      const handle = normalizeSecretHandle(channel, section.secretHandle);
      if (handle) secretHandles = { ...secretHandles, [channel]: handle };
    }
    const imessage = doc.imessage;
    if (record(imessage) && imessage.bridge === 'loopback') imessageBridge = 'loopback';
  } catch {
    secretHandles = {};
    imessageBridge = 'off';
  }
  return {
    owners,
    secretHandles,
    imessageBridge,
    confirmed: parseCommsConfirmation(readToml(configDir, 'comms.toml')),
    team: parseTeamIdentities(network),
  };
}

export function listAdapterStatus(settings: OwnerThreadSettings, halted: boolean, paused: boolean): OwnerAdapterStatus[] {
  return OWNER_CHANNELS.map(channel => adapterStatus(channel, settings, halted, paused));
}
