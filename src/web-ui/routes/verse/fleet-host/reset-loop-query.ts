import type { ResetReleaseLoopState, ResetReleaseRecord, ResetReleaseRow } from '../../../../core/fleet/usage-reset-release.js';
import { VERSE_OPS_RESET_RELEASES_PATH } from '../../../../core/verse/ops-types.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface ResetReleases {
  v: 1;
  generatedAt: string;
  loop: ResetReleaseLoopState;
  releases: ResetReleaseRecord[];
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const row = (value: unknown): value is ResetReleaseRow => object(value) &&
  typeof value.lane === 'string' && value.lane.length > 0 &&
  (value.state === 'reset-detected' || value.state === 'hold-expired') &&
  (value.usedPct === null || (typeof value.usedPct === 'number' && Number.isFinite(value.usedPct))) &&
  nullableString(value.readingAsOf) && nullableString(value.heldUntil);

export function narrowResetReleases(raw: unknown): ResetReleases | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string' || !object(raw.loop) || !Array.isArray(raw.releases)) return null;
  const loop = raw.loop;
  if (typeof loop.started !== 'boolean' || !nullableString(loop.lastRunAt) || !nullableString(loop.lastError)) return null;
  if (loop.lastResult !== null) {
    const result = loop.lastResult;
    if (!object(result) || typeof result.at !== 'string' || typeof result.checked !== 'number' || !Number.isInteger(result.checked) || result.checked < 0 ||
      !Array.isArray(result.released) || !result.released.every(row) || !Array.isArray(result.errors) ||
      !result.errors.every((error: unknown) => object(error) && typeof error.lane === 'string' && typeof error.message === 'string')) return null;
  }
  if (!raw.releases.every((record: unknown) => row(record) && object(record) && record.v === 1 &&
    typeof record.at === 'string' && record.by === 'reset-detect' && typeof record.reason === 'string')) return null;
  return raw as unknown as ResetReleases;
}

export const resetLoopQuery: QueryDef<ResetReleases | null> = {
  key: 'verse-reset-releases',
  async fetch(signal) {
    try { return narrowResetReleases(await apiGet<unknown>(VERSE_OPS_RESET_RELEASES_PATH, signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
