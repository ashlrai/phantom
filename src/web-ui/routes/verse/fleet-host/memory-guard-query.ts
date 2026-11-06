import type { FleetMemoryView } from '../../../../core/fleet/memory-view.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface FleetMemoryResponse {
  v: 1;
  generatedAt: string;
  memory: FleetMemoryView;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value));

export function narrowFleetMemory(raw: unknown): FleetMemoryResponse | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string' || !object(raw.memory)) return null;
  const memory = raw.memory;
  if (memory.schema !== 'fleet.memory.v1' || typeof memory.generatedAt !== 'string') return null;
  const { sample, memguard } = memory;
  if (!object(sample) || !object(memguard)) return null;
  for (const key of ['free_pct', 'swap_gb', 'swapouts_per_min', 'disk_gb', 'age_ms']) {
    if (!nullableNumber(sample[key])) return null;
  }
  if (!(sample.sampled_at === null || typeof sample.sampled_at === 'string')) return null;
  if (!(sample.stale === null || typeof sample.stale === 'boolean')) return null;
  if (!(memguard.level === null || typeof memguard.level === 'string' || (typeof memguard.level === 'number' && Number.isFinite(memguard.level)))) return null;
  if (!(memguard.stopped === null || (Array.isArray(memguard.stopped) && memguard.stopped.every((id: unknown) => typeof id === 'string')))) return null;
  if (!(memguard.omlx_down === undefined || typeof memguard.omlx_down === 'boolean')) return null;
  if (!(memguard.calm === undefined || (typeof memguard.calm === 'number' && Number.isFinite(memguard.calm)))) return null;
  return raw as unknown as FleetMemoryResponse;
}

export const memoryGuardQuery: QueryDef<FleetMemoryResponse | null> = {
  key: 'verse-fleet-memory',
  async fetch(signal) {
    try { return narrowFleetMemory(await apiGet<unknown>('/api/verse/fleet/memory', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
