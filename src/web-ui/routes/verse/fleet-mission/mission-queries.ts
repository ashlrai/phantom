import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export type { MissionDecision, MissionHealth, MissionJob, MissionMain, MissionResource } from '../../../../core/fleet/mission-control-types.js';
export type MissionControl = import('../../../../core/fleet/mission-control-types.js').MissionControlV1;

const str = (value: unknown): value is string => typeof value === 'string';
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nil = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const list = (check: (value: unknown) => boolean) => (value: unknown) => Array.isArray(value) && value.every(check);
const obj = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function isMissionControl(value: unknown): value is MissionControl {
  if (!obj(value) || value.schema !== 'fleet.mission.v1' || !obj(value.overview)) return false;
  if (value.timeline !== undefined && !list((row) => obj(row) && str(row.pr) && str(row.at))(value.timeline)) return false;
  if (value.activity !== undefined && !list((row) => obj(row) && str(row.job) && str(row.lane) && str(row.at))(value.activity)) return false;
  if (value.costPerMergedPrUsd !== undefined && !nil(num)(value.costPerMergedPrUsd)) return false;
  const overview = value.overview;
  const health = overview.health;
  if (health !== 'clear' && health !== 'watch' && health !== 'attention' && health !== 'unknown') return false;
  if (!str(overview.headline) || !str(overview.shipped) || !nil(str)(overview.attention)) return false;
  if (!list((item) => obj(item) && str(item.id) && str(item.text))(overview.items)) return false;
  if (!list((job) => obj(job) && str(job.label) && nil(str)(job.model) && num(job.running) && num(job.queued))(value.jobs)) return false;
  if (!list((row) => obj(row) && str(row.at) && str(row.why))(value.decisions)) return false;
  if (!list((row) => obj(row) && str(row.label))(value.resources)) return false;
  if (!list((row) => obj(row) && str(row.repo) && num(row.perHour))(value.merges)) return false;
  if (!list((row) => obj(row) && str(row.repo))(value.mains)) return false;
  if (!list((row) => obj(row) && str(row.title))(value.incidents)) return false;
  if (!obj(value.memory) || !str(value.memory.note) || !obj(value.plan) || !list(str)(value.plan.points)) return false;
  return nil(str)(value.plan.title);
}

export const missionQuery: QueryDef<MissionControl | null> = {
  key: 'verse-fleet-mission',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/fleet/runs/mission', signal);
      if (!isMissionControl(value)) throw new Error('Invalid mission response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
