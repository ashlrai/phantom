import type { FleetRuns } from '../ops/ops-runs-model.js';
import { JOB_ID_RE, safePrUrl } from '../fleet-job-log/worker-log-model.js';
import type { PaletteWorker } from './palette-model.js';

/** Fleet snapshot → validated, deduplicated palette candidates. */
export function paletteWorkers(runs: FleetRuns | null | undefined): PaletteWorker[] {
  const candidates = new Map<string, PaletteWorker>();
  for (const claim of runs?.claimed ?? []) {
    if (JOB_ID_RE.test(claim.job)) candidates.set(claim.job, { ...claim, state: 'queued', ageSeconds: null, prUrl: null });
  }
  const publishes = [...(runs?.publishesLastHour ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  for (const publish of publishes) {
    if (JOB_ID_RE.test(publish.job)) candidates.set(publish.job, {
      job: publish.job, lane: publish.lane ?? '', tier: '', ageSeconds: null,
      state: 'merged', at: publish.at, prUrl: safePrUrl(publish.url),
    });
  }
  for (const worker of runs?.workers ?? []) {
    if (JOB_ID_RE.test(worker.job)) candidates.set(worker.job, {
      job: worker.job, lane: worker.lane, tier: worker.tier, ageSeconds: worker.ageSeconds,
      state: 'running', at: null, prUrl: candidates.get(worker.job)?.state === 'merged' ? candidates.get(worker.job)!.prUrl : null,
    });
  }
  const rank = { running: 0, queued: 1, merged: 2 } as const;
  return [...candidates.values()].sort((a, b) => rank[a.state!] - rank[b.state!]
    || (a.state === 'running' ? (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1) : 0)
    || a.job.localeCompare(b.job));
}
