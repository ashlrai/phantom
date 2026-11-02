import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { channelKey, KNOWN_CHANNELS, type ChannelKey } from './fleet-channels-model.js';

export type MirrorTone = 'ok' | 'warn' | 'none';
export type BusState = 'available' | 'unavailable' | 'loading';
export interface ChannelMirror { inbox: number; mirrored: number; tone: MirrorTone; text: string }

// Wire names are defined by INBOUND_CHANNELS in channel-envelope.ts.
const busChannels: Record<string, ChannelKey | undefined> = {
  email: 'email', telegram: 'telegram', mobile: 'mobile', desktop: 'desktop', page: 'page', cli: 'terminal',
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function mirrorByChannel(inboxEntries: readonly unknown[], receipts: readonly AgentBusReceipt[], nowMs: number, windowMs = 3_600_000): Map<ChannelKey, ChannelMirror> {
  const counts = new Map<ChannelKey, { inbox: number; mirrored: number }>(KNOWN_CHANNELS.map(key => [key, { inbox: 0, mirrored: 0 }]));
  const withinWindow = (at: number) => Number.isFinite(at) && at <= nowMs && at >= nowMs - windowMs;
  const countFor = (key: ChannelKey) => {
    let count = counts.get(key);
    if (!count) { count = { inbox: 0, mirrored: 0 }; counts.set(key, count); }
    return count;
  };
  for (const value of inboxEntries) {
    const entry = record(value);
    if (typeof entry.at === 'string' && typeof entry.source === 'string' && typeof entry.text === 'string' && withinWindow(Date.parse(entry.at))) {
      countFor(channelKey(entry.source)).inbox++;
    }
  }
  for (const receipt of receipts) {
    const body = record(receipt.envelope.body);
    const key = typeof body.channel === 'string' && Object.hasOwn(busChannels, body.channel) ? busChannels[body.channel] : undefined;
    if (receipt.envelope.from === 'mason' && body.kind === 'interjection' && key && withinWindow(receipt.receivedAt)) countFor(key).mirrored++;
  }
  return new Map([...counts].map(([key, { inbox, mirrored }]) => {
    const tone: MirrorTone = inbox === 0 && mirrored === 0 ? 'none' : inbox > 0 && mirrored === 0 ? 'warn' : 'ok';
    return [key, { inbox, mirrored, tone, text: `mirrored ${mirrored} of ${inbox} in the last hour` }];
  }));
}

export function mirrorHint(tone: MirrorTone, busState: BusState): string | null {
  if (busState === 'unavailable') return 'Bus unavailable, cannot verify';
  return tone === 'warn' && busState === 'available'
    ? 'Messages reach the inbox but not the bus: the hub needs --allow-dispatch and a writable bus store'
    : null;
}
