import type { FleetLaneModelsV1 } from '../../../../core/verse/fleet-lane-models-contract.js';

const find = (lane: string, data: FleetLaneModelsV1 | null | undefined) => data?.source === 'ok' ? data.lanes.find(row => row.lane === lane) : undefined;
export function laneModelLine(lane: string, data: FleetLaneModelsV1 | null | undefined, nowMs: number): string | null {
  const row = find(lane, data);
  if (!row) return null;
  const groups = new Map<string, string[]>();
  for (const { tier, model } of row.tiers) {
    if (model === null) continue;
    groups.set(model, [...(groups.get(model) ?? []), tier]);
  }
  const parts = [...groups].map(([model, tiers]) => `${tiers.join(', ')} ${model}`);
  if (row.lastLaunch) {
    const launch = row.lastLaunch;
    const age = launch.at === null ? NaN : nowMs - Date.parse(launch.at);
    const minutes = Math.floor(Math.max(0, age) / 60_000);
    const ago = !Number.isFinite(age) ? '' : minutes < 1 ? ' just now' : minutes < 60 ? ` ${minutes} min ago` : ` ${Math.floor(minutes / 60)} h ago`;
    parts.push(`last launch ${launch.tier ? `${launch.tier} → ` : ''}${launch.model}${ago}`);
  }
  return parts.join(' · ') || null;
}
export function mismatchText(lane: string, data: FleetLaneModelsV1 | null | undefined): string | null {
  const row = find(lane, data);
  if (!row?.mismatch || !row.lastLaunch) return null;
  const expected = row.lastLaunch.tier ? row.tiers.find(t => t.tier === row.lastLaunch!.tier)?.model
    : [...new Set(row.tiers.flatMap(t => t.model ? [t.model] : []))].join(', ');
  return `last launch used ${row.lastLaunch.model}, table says ${expected || 'unknown'}`;
}
export function laneModelsHeadline(data: FleetLaneModelsV1 | null | undefined): string | null {
  return data?.source === 'ok' ? `Models: ${data.lanes.length} lanes, ${data.lanes.filter(row => row.mismatch).length} mismatches` : null;
}
