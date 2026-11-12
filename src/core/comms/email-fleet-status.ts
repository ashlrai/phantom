/** A counts-only projection of the existing local fleet readers for email. */
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../fleet/runs-live-workers.js';
import { readStatusSupply, supplyLines, type StatusSupply } from './status-supply-line.js';
import { boundedQuotaLines, readQuotaLines } from './status-quota-lines.js';

export interface EmailFleetStatusReaders {
  runs?: () => Promise<FleetRunsDirState>;
  workers?: () => Promise<LiveWorkersSnapshot>;
  supply?: () => Promise<StatusSupply>;
  readQuota?: () => string[];
}

const count = (value: number): string => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? String(value) : 'unavailable';
// Same dispatcher freshness window as the Leader status snapshot (fleet/status-api.ts):
// a status source older than this describes a stopped dispatcher, not live fleet activity.
const DISPATCHER_FRESH_MS = 60_000;

/** Never forward free text, identifiers, paths, diagnostics, or raw reader objects. */
export async function emailFleetStatus(runsDir: string | undefined, now: () => Date, readers: EmailFleetStatusReaders = {}): Promise<string> {
  let at: Date | undefined;
  try {
    const candidate = now();
    if (Number.isFinite(candidate.getTime())) at = candidate;
  } catch {
    // A failed clock must not discard independent reader results.
  }
  const requireTime = (): Date => {
    if (!at) throw new Error('clock unavailable');
    return at;
  };
  const [runs, workers, supply, quota] = await Promise.allSettled([
    Promise.resolve().then(readers.runs ?? (() => { const time = requireTime(); return readFleetRunsDirState({ runsDir, now: () => time.getTime() }); })),
    Promise.resolve().then(readers.workers ?? (() => { const time = requireTime(); return listLiveWorkers({ now: () => time.getTime() }); })),
    Promise.resolve().then(readers.supply ?? (() => { const time = requireTime(); return readStatusSupply(runsDir, () => time); })),
    Promise.resolve().then(() => (readers.readQuota ?? (() => readQuotaLines(requireTime().getTime())))()),
  ]);
  const lines = [`Phantom fleet status (${at ? at.toISOString() : 'unavailable'})`];
  if (runs.status !== 'fulfilled' || runs.value.sources.status !== 'healthy') {
    lines.push('Runs status: unavailable');
  } else {
    const state = runs.value;
    const tickMs = typeof state.lastTick === 'string' ? Date.parse(state.lastTick) : Number.NaN;
    const ageMs = at && Number.isFinite(tickMs) ? at.getTime() - tickMs : Number.NaN;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > DISPATCHER_FRESH_MS) {
      // Freshness is unprovable: report the bounded observation time, never live counts.
      lines.push(at && Number.isFinite(tickMs)
        ? `Runs status: stale; last tick: ${new Date(tickMs).toISOString()}`
        : 'Runs status: unavailable');
    } else {
      lines.push(`Runs status: available; paused: ${state.paused === null ? 'unavailable' : state.paused ? 'yes' : 'no'}`);
      // The reader admits a fixed lane set; do not echo lane labels or free text.
      const lanes = state.lanes.slice(0, 64);
      for (const key of ['running', 'target', 'queued'] as const) {
        const values = lanes.map(lane => lane[key]);
        const total = values.reduce((sum, value) => sum + value, 0);
        lines.push(`${key}: ${state.lanes.length > 64 || values.some(value => count(value) === 'unavailable') ? 'unavailable' : count(total)}`);
      }
      lines.push(`held lanes: ${count(lanes.filter(lane => lane.held).length)}`);
    }
  }
  if (workers.status !== 'fulfilled' || workers.value.sourceState !== 'healthy') {
    lines.push('Live workers: unavailable');
  } else {
    lines.push(`Live workers: ${count(workers.value.workers.length)}`);
    lines.push(`Leader passes: ${count(workers.value.leaders.length)}`);
    lines.push(`Orchestrator agents: ${count(workers.value.orchestratorAgents)}`);
  }
  lines.push(...(quota.status === 'fulfilled' ? boundedQuotaLines(quota.value) : ['Quota: unavailable']));
  lines.push(...(supply.status === 'fulfilled' ? supplyLines(supply.value) : ['Supply: unavailable', 'Planner: unknown (unavailable)']));
  return lines.join('\n');
}
