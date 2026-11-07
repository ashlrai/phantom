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
  if (memory.resource_session !== undefined) {
    const resource = memory.resource_session;
    const member = (value: unknown, allowed: string[]): value is string => typeof value === 'string' && allowed.includes(value);
    const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!object(resource) || !member(resource.state, ['fresh', 'stale', 'future', 'unknown']) ||
        !(resource.sampled_at === null || (typeof resource.sampled_at === 'string' && Number.isFinite(Date.parse(resource.sampled_at)))) || !nullableNumber(resource.age_ms) ||
        !member(resource.pressure, ['normal', 'warning', 'critical', 'not-applicable', 'unknown']) ||
        !member(resource.censusState, ['known', 'unknown']) || !member(resource.sessionsState, ['known', 'unknown']) ||
        !Array.isArray(resource.sessions) || resource.sessions.length > 256 || (resource.sessionsState === 'unknown' && resource.sessions.length > 0)) return null;
    if (resource.state === 'unknown' ? resource.age_ms !== null || resource.sampled_at !== null :
      typeof resource.age_ms !== 'number' || resource.sampled_at === null ||
      (resource.state === 'fresh' ? resource.age_ms < 0 || resource.age_ms > 30000 :
        resource.state === 'stale' ? resource.age_ms <= 30000 : resource.age_ms >= 0)) return null;
    if (resource.state !== 'fresh' && (resource.pressure !== 'unknown' || resource.censusState !== 'unknown' || resource.sessionsState !== 'unknown' || resource.sessions.length !== 0)) return null;
    const disk = resource.disk;
    if (!object(disk) || !member(disk.state, ['history', 'stale', 'unknown'])) return null;
    if (disk.state === 'unknown' ? disk.allocatedBytes !== null || disk.ageSeconds !== null || disk.provenance !== null :
      !nonnegative(disk.allocatedBytes) || !nonnegative(disk.ageSeconds) || typeof disk.provenance !== 'string' || disk.provenance.length > 256) return null;
    if ((resource.state === 'future' || resource.state === 'unknown') && disk.state !== 'unknown' || resource.state === 'stale' && disk.state === 'history') return null;
    const seen = new Set<string>();
    for (const row of resource.sessions) {
      if (!object(row) || typeof row.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.jobId) || seen.has(row.jobId) ||
          !member(row.state, ['known', 'unknown']) || row.swapBytes !== null ||
          !['processCount', 'rssBytes', 'cpuPercentOneCore', 'cpuPercentHost'].every(key => row[key] === null || nonnegative(row[key]))) return null;
      const metrics = [row.processCount, row.rssBytes, row.cpuPercentOneCore, row.cpuPercentHost];
      if (row.state === 'unknown' ? metrics.some(value => value !== null) :
        typeof row.processCount !== 'number' || !Number.isSafeInteger(row.processCount) || row.processCount <= 0 || row.rssBytes === null || row.cpuPercentOneCore === null) return null;
      seen.add(row.jobId);
    }
  }
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
