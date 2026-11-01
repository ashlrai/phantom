/** A counts-only projection of the existing local fleet readers for email. */
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../fleet/runs-live-workers.js';

export interface EmailFleetStatusReaders {
  runs?: () => Promise<FleetRunsDirState>;
  workers?: () => Promise<LiveWorkersSnapshot>;
}

const count = (value: number): string => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? String(value) : 'unavailable';

/** Never forward free text, identifiers, paths, diagnostics, or raw reader objects. */
export async function emailFleetStatus(runsDir: string | undefined, now: () => Date, readers: EmailFleetStatusReaders = {}): Promise<string> {
  const at = now();
  const [runs, workers] = await Promise.allSettled([
    Promise.resolve().then(readers.runs ?? (() => readFleetRunsDirState({ runsDir, now: () => at.getTime() }))),
    Promise.resolve().then(readers.workers ?? (() => listLiveWorkers({ now: () => at.getTime() }))),
  ]);
  const lines = [`Phantom fleet status (${at.toISOString()})`];
  if (runs.status !== 'fulfilled' || runs.value.sources.status !== 'healthy') {
    lines.push('Runs status: unavailable');
  } else {
    const state = runs.value;
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
  if (workers.status !== 'fulfilled' || workers.value.sourceState !== 'healthy') {
    lines.push('Live workers: unavailable');
  } else {
    lines.push(`Live workers: ${count(workers.value.workers.length)}`);
    lines.push(`Leader passes: ${count(workers.value.leaders.length)}`);
    lines.push(`Orchestrator agents: ${count(workers.value.orchestratorAgents)}`);
  }
  return lines.join('\n');
}
