/**
 * One adapter surface for the owner's channels. Every adapter is disabled
 * until its owner identity is configured. Remote credentials are Phantom
 * Secrets handle names, never values.
 */
import { join } from 'node:path';
import { realAccountHome } from '../config.js';
import { parse } from 'smol-toml';
import type { TeamIdentity } from '../agents/channel-policy.js';
import { parseCommsConfirmation, parseTeamIdentities } from '../agents/channel-policy.js';
import { parseMasonIdentities } from '../agents/leader-network.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import {
  OWNER_CHANNELS,
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
  const home = realAccountHome();
  return home ? join(home, '.ashlr') : join('/owner-home-unavailable');
}

/** Real runs directory. `$HOME` and `ASHLR_RUNS_DIR` cannot retarget email-drop. */
export function fixedOwnerRunsDir(): string {
  const home = realAccountHome();
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
  if (channel === 'telegram' || channel === 'email' || channel === 'slack') {
    if (!secretHandle) {
      configured = false;
      reason = 'Disabled until the Phantom Secrets handle is named.';
    } else if (!ownerId) {
      configured = false;
      reason = 'Disabled until an owner identity is configured.';
    } else {
      reason = 'Owner identity and secret handle are configured.';
    }
  }
  if (channel === 'imessage') {
    if (settings.imessageBridge !== 'loopback') {
      configured = false;
      reason = 'iMessage is loopback-only and stays disabled until the local bridge is selected.';
    } else if (!ownerId) {
      configured = false;
      reason = 'Disabled until an owner identity is configured.';
    } else {
      reason = 'Loopback bridge and owner identity are configured.';
    }
  }
  if (channel === 'desktop' && ownerId) reason = 'Native desktop thread is configured.';
  const enabled = configured && !halted && !paused;
  if (halted) reason = 'Kill switch halted this adapter.';
  else if (paused && configured) reason = 'Communications are paused.';
  return { id: channel, configured, enabled, halted, secretHandle, reason };
}

export function ownerAllowed(channel: OwnerChannel, senderId: string, settings: OwnerThreadSettings): boolean {
  return senderId.length > 0 && settings.owners[channel] === senderId;
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
