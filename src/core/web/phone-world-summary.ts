/**
 * Phone-sized reading of ashlr.world-model/v1.
 * Unknown stays null. A measured zero is returned only when the field is fresh
 * or stale and the value is actually 0.
 */
import type { Field, Freshness, WorldModel } from '../world/types.js';

export interface PhoneMeter {
  value: number | null;
  freshness: Freshness;
}

export interface PhoneTextMeter {
  value: string | null;
  freshness: Freshness;
}

export interface PhoneWorldSummary {
  lanes: Array<{ lane: string; headroom: PhoneMeter }>;
  pulls: Array<{ repo: string; mergedPerDay: PhoneMeter }> | null;
  releases: { updateCheck: PhoneTextMeter; train: PhoneTextMeter };
  bottlenecks: PhoneMeter;
}

function meterNumber(field: Field<number> | undefined): PhoneMeter {
  if (!field || (field.freshness !== 'fresh' && field.freshness !== 'stale' && field.freshness !== 'unknown')) {
    return { value: null, freshness: 'unknown' };
  }
  if (field.freshness === 'unknown' || typeof field.value !== 'number' || !Number.isFinite(field.value)) {
    return { value: null, freshness: field.freshness === 'unknown' ? 'unknown' : field.freshness };
  }
  return { value: field.value, freshness: field.freshness };
}

function meterText(field: Field<string> | undefined): PhoneTextMeter {
  if (!field || (field.freshness !== 'fresh' && field.freshness !== 'stale' && field.freshness !== 'unknown')) {
    return { value: null, freshness: 'unknown' };
  }
  if (field.freshness === 'unknown' || typeof field.value !== 'string' || field.value.length === 0) {
    return { value: null, freshness: field.freshness === 'unknown' ? 'unknown' : field.freshness };
  }
  return { value: field.value, freshness: field.freshness };
}

/** Null when the payload is not a world-model snapshot. */
export function summarizeWorldForPhone(raw: unknown): PhoneWorldSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const model = raw as Partial<WorldModel>;
  if (model.schema !== 'ashlr.world-model/v1' || !model.sensors || !Array.isArray(model.sensors.lanes)) return null;
  const lanes = model.sensors.lanes.flatMap((lane) => {
    if (!lane || typeof lane.lane !== 'string' || lane.lane.length === 0) return [];
    return [{ lane: lane.lane, headroom: meterNumber(lane.headroom) }];
  });
  const repos = model.outcomes?.repos;
  const pulls = Array.isArray(repos)
    ? repos.flatMap((repo) => {
      if (!repo || typeof repo.repo !== 'string' || repo.repo.length === 0) return [];
      return [{ repo: repo.repo, mergedPerDay: meterNumber(repo.mergedPerDay) }];
    })
    : null;
  return {
    lanes,
    pulls,
    releases: {
      updateCheck: meterText(model.releases?.updateCheck),
      train: meterText(model.releases?.train),
    },
    bottlenecks: meterNumber(model.bottlenecks?.count),
  };
}
