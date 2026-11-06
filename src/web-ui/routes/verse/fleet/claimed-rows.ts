import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

type ClaimRuns = Pick<FleetRuns, 'claimed' | 'workers' | 'lastTick'>;
export interface ClaimedRow {
  job: string;
  lane: string;
  tier: string;
  ageSeconds: number;
  ageText: string;
  startedElsewhere: boolean;
}

export function claimedRows(runs: ClaimRuns, nowMs: number): ClaimedRow[] {
  const running = new Set(runs.workers.map(worker => worker.job));
  return (runs.claimed ?? []).flatMap(claim => {
    const at = Date.parse(claim.at);
    if (running.has(claim.job) || !Number.isFinite(at)) return [];
    const ageSeconds = Math.max(0, (nowMs - at) / 1000);
    return [{ job: claim.job, lane: claim.lane, tier: claim.tier, ageSeconds,
      ageText: ageText(ageSeconds), startedElsewhere: false }];
  }).sort((a, b) => a.ageSeconds - b.ageSeconds);
}

function minutes(seconds: number): string {
  const value = Math.floor(seconds / 60);
  return `${value} min`;
}

export function claimedTell(rows: ClaimedRow[], runs: ClaimRuns, nowMs: number): { text: string; tone: 'warn' | 'bad' } | null {
  if (runs.claimed === undefined || !rows.length) return null;
  const oldest = Math.max(...rows.map(row => row.ageSeconds));
  if (oldest <= 300) return null;
  const tickMs = runs.lastTick === null ? NaN : Date.parse(runs.lastTick);
  const tickAge = Number.isFinite(tickMs) ? Math.max(0, (nowMs - tickMs) / 1000) : null;
  return {
    text: `Dispatch is not starting claimed jobs (oldest ${minutes(oldest)}, last tick ${tickAge === null ? 'unknown' : `${minutes(tickAge)} ago`})`,
    tone: oldest > 900 || (tickAge !== null && tickAge > 1200) ? 'bad' : 'warn',
  };
}
