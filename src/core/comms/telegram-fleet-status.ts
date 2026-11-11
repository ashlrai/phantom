/** Bounded, allowlisted projection of the local fleet readers for Telegram. */
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from '../fleet/runs-live-workers.js';
import { readStatusSupply, supplyLines, type StatusSupply } from './status-supply-line.js';
import { boundedQuotaLines, readQuotaLines } from './status-quota-lines.js';

export interface TelegramFleetStatusDeps {
  readRuns?: () => Promise<FleetRunsDirState>;
  readWorkers?: () => Promise<LiveWorkersSnapshot>;
  readSupply?: () => Promise<StatusSupply>;
  readQuota?: () => string[];
  runsDir?: string;
  now?: () => Date;
}

const LANES = [
  'codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local',
  'devin-flash', 'gemini', 'zai', 'agy', 'grok', 'cursor',
] as const;
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
  let now = new Date(NaN);
  try { now = (deps.now ?? (() => new Date()))(); } catch { /* Clock evidence is unavailable. */ }
  const clock = now instanceof Date ? now.getTime() : NaN;
  const time = Number.isFinite(clock) ? new Date(clock).toISOString() : 'unavailable';
  const [runsResult, workersResult, supplyResult, quotaResult] = await Promise.allSettled([
    Promise.resolve().then(() => (deps.readRuns ?? (() => readFleetRunsDirState({ runsDir: deps.runsDir, now: () => clock })))()),
    Promise.resolve().then(() => (deps.readWorkers ?? (() => listLiveWorkers({ now: () => clock })))()),
    Promise.resolve().then(() => (deps.readSupply ?? (() => readStatusSupply(deps.runsDir, () => now)))()),
    Promise.resolve().then(() => (deps.readQuota ?? (() => readQuotaLines(clock)))()),
  ]);
  const runs = runsResult.status === 'fulfilled' ? runsResult.value : null;
  const workers = workersResult.status === 'fulfilled' ? workersResult.value : null;
  const tick = timestamp(runs?.lastTick);
  const tickMs = tick === 'unavailable' ? NaN : Date.parse(tick);
  const age = clock - tickMs;
  const dispatcher = runs?.sources.status === 'healthy' && Number.isFinite(age) && age >= 0 && age <= 60_000;
  const observation = dispatcher ? 'current' : Number.isFinite(age) && age > 60_000 ? 'stale' : 'unknown';
  const observed = workers?.sourceState === 'healthy' ? workers.workers : null;
  const rows = LANES.map(lane => {
    const laneData = runs?.lanes.find(item => item.lane === lane);
    const reported = dispatcher ? laneData : undefined;
    const live = observed ? count(observed.filter(item => item.lane === lane).length) : 'unavailable';
    const usage = runs?.sources.metrics === 'healthy' ? count(laneData?.tokensLastHour) : 'unavailable';
    return `${lane}: observed ${live}; reported ${count(reported?.running)}; queue ${count(reported?.queued)}; target ${count(reported?.target)}; held ${reported ? (reported.held ? 'yes' : 'no') : 'unavailable'}; tokens/1h ${usage}`;
  });
  const other = observed ? count(observed.filter(item => !LANES.some(lane => lane === item.lane)).length) : 'unavailable';
  const sources = SOURCES.map(key => `${key}=${health(runs?.sources[key])}`).join(', ');
  return [
    `Fleet status at ${time}`,
    ...rows,
    `Other lanes: observed ${other}; reported/queue/target/held unavailable`,
    `Last tick: ${tick} (dispatcher observation ${observation})`,
    `Sources: runs=${health(runs?.sourceState)}, workers=${health(workers?.sourceState)}; ${sources}`,
    'Usage: token counts are local completed-job metrics; quota lines come from provider windows; unavailable when unknown.',
    ...(quotaResult.status === 'fulfilled' ? boundedQuotaLines(quotaResult.value) : ['Quota: unavailable']),
    ...(supplyResult.status === 'fulfilled' ? supplyLines(supplyResult.value) : ['Supply: unavailable', 'Planner: unknown (unavailable)']),
  ].join('\n');
}
