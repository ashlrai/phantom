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

function channelHealthy(id: ChannelId): boolean {
  if (id !== 'bus' && id !== 'handoff') return false;
  const inspection = inspectBusInbox();
  return inspection.source === 'missing' || inspection.source === 'available';
}

export function listChannelRegistry(): Array<{ id: ChannelId; adapterRegistered: boolean; healthy: boolean }> {
  ensureDefaultAdapters();
  return CHANNEL_IDS.map(id => ({
    id,
    adapterRegistered: registry.has(id),
    healthy: registry.has(id) ? channelHealthy(id) : false,
  }));
}

export async function probeRegisteredChannel(id: ChannelId, options: BusInboxOptions = {}): Promise<DeliverResult & { dryRun: boolean }> {
  ensureDefaultAdapters();
  if (!registry.has(id)) return { dryRun: true, status: 'refused', reason: 'No channel adapter is registered.' };
  if (id === 'bus') return { dryRun: false, ...(await probeBusChannel(options)) };
  if (id === 'handoff') return { dryRun: false, ...(await probeHandoffChannel(options)) };
  return { dryRun: true, status: 'refused', reason: 'No local probe is registered for this adapter.' };
}
