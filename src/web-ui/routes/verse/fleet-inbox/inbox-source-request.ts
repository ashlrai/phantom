import { useSyncExternalStore } from 'react';
import type { ChannelKey } from '../fleet-channels/fleet-channels-model.js';

let pendingChannel: ChannelKey | null = null;
const listeners = new Set<() => void>();

function setPendingChannel(channel: ChannelKey | null): void {
  if (pendingChannel === channel) return;
  pendingChannel = channel;
  for (const listener of [...listeners]) listener();
}

export function requestInboxChannel(channel: ChannelKey): void {
  setPendingChannel(channel);
}

export function takeRequestedInboxChannel(): ChannelKey | null {
  const channel = pendingChannel;
  setPendingChannel(null);
  return channel;
}

export function subscribeInboxChannelRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): ChannelKey | null => pendingChannel;

export function useRequestedInboxChannel(): ChannelKey | null {
  return useSyncExternalStore(subscribeInboxChannelRequest, getSnapshot, getSnapshot);
}
