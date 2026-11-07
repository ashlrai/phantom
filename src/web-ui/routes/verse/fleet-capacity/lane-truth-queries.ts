import type { LaneVerdict } from '../../../../core/fleet/lane-truth.js';
import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optCount = (value: unknown): value is number | null => value === null || count(value);
const optDate = (value: unknown): value is string | null => value === null || typeof value === 'string';
const optBool = (value: unknown): value is boolean | null => value === null || typeof value === 'boolean';
const VERDICTS: readonly LaneVerdict[] = ['held_with_capacity', 'reset_detected', 'idle_with_work', 'ok', 'unknown'];

export interface LaneTruthMeter {
  provider: string;
  usedPercent: number | null;
  resetAt: string | null;
  sampledAt: string;
}
export interface LaneTruthLane {
  lane: string;
  verdict: LaneVerdict;
  target: number | null;
  running: number | null;
  queued: number | null;
  held: boolean | null;
  meter: LaneTruthMeter | null;
  reason: string;
}
export interface LaneTruth {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  maxAgeMs: number;
  lanes: LaneTruthLane[];
}

const isMeter = (value: unknown): value is LaneTruthMeter => record(value) && typeof value.provider === 'string'
  && (value.usedPercent === null || typeof value.usedPercent === 'number')
  && optDate(value.resetAt) && typeof value.sampledAt === 'string';

export function isLaneTruth(value: unknown): value is LaneTruth {
  return record(value) && value.v === 1 && date(value.generatedAt) && count(value.maxAgeMs)
    && (value.source === 'ok' || value.source === 'unavailable') && Array.isArray(value.lanes)
    && value.lanes.every((lane: unknown) => record(lane) && typeof lane.lane === 'string' && lane.lane.length > 0
      && VERDICTS.includes(lane.verdict as LaneVerdict) && optCount(lane.target) && optCount(lane.running) && optCount(lane.queued)
      && optBool(lane.held) && (lane.meter === null || isMeter(lane.meter)) && typeof lane.reason === 'string');
}

/** GET /api/verse/runs-history/lane-truth — 404 means this build has no lane truth route yet. */
export const laneTruthQuery: QueryDef<LaneTruth | null> = {
  key: 'verse-runs-history-lane-truth',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/runs-history/lane-truth', signal);
      if (!isLaneTruth(value)) throw new Error('Invalid lane truth response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
