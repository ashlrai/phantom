/** Runtime channel adapter registry. Registration is process-local and starts with bus and handoff. */
import { CHANNEL_IDS, type ChannelAdapter, type ChannelId, type DeliverResult } from './channel-policy.js';
import { createBusChannelAdapter, probeBusChannel } from './adapters/bus.js';
import { createHandoffChannelAdapter, probeHandoffChannel } from './adapters/handoff.js';
import { inspectBusInbox, type BusInboxOptions } from '../fleet/bus-inbox.js';

const registry = new Map<ChannelId, ChannelAdapter>();
let installed = false;

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  if (!CHANNEL_IDS.some(id => id === adapter.id)) throw new Error('Unknown channel');
  registry.set(adapter.id, adapter);
}

export function resetChannelRegistryForTests(): void {
  registry.clear();
  installed = false;
}

export function ensureDefaultAdapters(): void {
  if (installed) return;
  installed = true;
  registerChannelAdapter(createBusChannelAdapter());
  registerChannelAdapter(createHandoffChannelAdapter());
}

export function getChannelAdapter(id: ChannelId): ChannelAdapter | undefined {
  ensureDefaultAdapters();
  return registry.get(id);
}

export function localChannelAdapters(options: BusInboxOptions = {}): Partial<Record<ChannelId, ChannelAdapter>> {
  return {
    bus: createBusChannelAdapter(options),
    handoff: createHandoffChannelAdapter(options),
  };
}

/** `true` usable, `false` confirmed down, `'unknown'` when nothing can assess it. */
export type ChannelHealth = boolean | 'unknown';

function channelHealthy(id: ChannelId, options: BusInboxOptions): ChannelHealth {
  if (id !== 'bus' && id !== 'handoff') return 'unknown';
  const inspection = inspectBusInbox(options);
  if (inspection.source === 'unavailable') return false;
  return true;
}

export function listChannelRegistry(options: BusInboxOptions = {}): Array<{ id: ChannelId; adapterRegistered: boolean; healthy: ChannelHealth }> {
  ensureDefaultAdapters();
  return CHANNEL_IDS.map(id => ({
    id,
    adapterRegistered: registry.has(id),
    healthy: registry.has(id) ? channelHealthy(id, options) : 'unknown',
  }));
}

export async function probeRegisteredChannel(id: ChannelId, options: BusInboxOptions = {}): Promise<DeliverResult & { dryRun: boolean }> {
  ensureDefaultAdapters();
  if (!registry.has(id)) return { dryRun: true, status: 'refused', reason: 'No channel adapter is registered.' };
  if (id === 'bus') return { dryRun: false, ...(await probeBusChannel(options)) };
  if (id === 'handoff') return { dryRun: false, ...(await probeHandoffChannel(options)) };
  return { dryRun: true, status: 'refused', reason: 'No local probe is registered for this adapter.' };
}
