/** Bounded, allowlisted projection of the local fleet readers for Telegram. */
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../fleet/runs-live-workers.js';

export interface TelegramFleetStatusDeps {
  readRuns?: () => Promise<FleetRunsDirState>;
  readWorkers?: () => Promise<LiveWorkersSnapshot>;
  runsDir?: string;
  now?: () => Date;
}

const LANES = ['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local'] as const;
const SOURCES = ['status', 'claimed', 'events', 'metrics', 'claudeLane', 'switches', 'drop'] as const;
const count = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unavailable';
const health = (value: unknown): string =>
  value === 'healthy' || value === 'missing' || value === 'degraded' || value === 'unavailable' ? value : 'unavailable';
const timestamp = (value: string | null | undefined): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return 'unavailable';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : 'unavailable';
};

export async function telegramFleetStatus(deps: TelegramFleetStatusDeps = {}): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const time = Number.isFinite(now.getTime()) ? now.toISOString() : 'unavailable';
  const [runsResult, workersResult] = await Promise.allSettled([
    Promise.resolve().then(() => (deps.readRuns ?? (() => readFleetRunsDirState({ runsDir: deps.runsDir, now: () => now.getTime() })))()),
    Promise.resolve().then(() => (deps.readWorkers ?? (() => listLiveWorkers({ now: () => now.getTime() })))()),
  ]);
  const runs = runsResult.status === 'fulfilled' ? runsResult.value : null;
  const workers = workersResult.status === 'fulfilled' ? workersResult.value : null;
  const observed = workers?.sourceState === 'healthy' ? workers.workers : null;
  const rows = LANES.map(lane => {
    const reported = runs?.lanes.find(item => item.lane === lane);
    const live = observed ? count(observed.filter(item => item.lane === lane).length) : 'unavailable';
    const usage = runs?.sources.metrics === 'healthy' ? count(reported?.tokensLastHour) : 'unavailable';
    return `${lane}: observed ${live}; reported ${count(reported?.running)}; queue ${count(reported?.queued)}; target ${count(reported?.target)}; held ${reported ? (reported.held ? 'yes' : 'no') : 'unavailable'}; tokens/1h ${usage}`;
  });
  const other = observed ? count(observed.filter(item => !LANES.some(lane => lane === item.lane)).length) : 'unavailable';
  const sources = SOURCES.map(key => `${key}=${health(runs?.sources[key])}`).join(', ');
  return [
    `Fleet status at ${time}`,
    ...rows,
    `Other lanes: observed ${other}; reported/queue/target/held unavailable`,
    `Last tick: ${timestamp(runs?.lastTick)}`,
    `Sources: runs=${health(runs?.sourceState)}, workers=${health(workers?.sourceState)}; ${sources}`,
    'Usage: token counts are local completed-job metrics, not subscription quota; unavailable when unknown.',
  ].join('\n');
}
