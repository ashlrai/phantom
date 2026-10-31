import type { FleetRuns } from '../ops/ops-runs-model.js';
import { JOB_ID_RE, safePrUrl } from '../fleet-job-log/worker-log-model.js';
import type { PaletteWorker } from './palette-model.js';

/** Fleet snapshot → validated, oldest-first palette candidates. */
export function paletteWorkers(runs: FleetRuns | null | undefined): PaletteWorker[] {
  const publishes = new Map([...(runs?.publishesLastHour ?? [])]
    .sort((a, b) => a.at.localeCompare(b.at)).map(p => [p.job, safePrUrl(p.url)]));
  return (runs?.workers ?? []).filter(w => JOB_ID_RE.test(w.job))
    .map(w => ({ job: w.job, lane: w.lane, tier: w.tier, ageSeconds: w.ageSeconds, prUrl: publishes.get(w.job) ?? null }))
    .sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1) || a.job.localeCompare(b.job));
}
