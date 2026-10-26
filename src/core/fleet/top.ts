/** Read-only, allowlisted top.v1 snapshot. No dispatch or provider collection. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnlyStrict } from '../config.js';
import type { AshlrConfig, EngineId } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { readBudgetPolicyFileState, readCapacitySnapshot } from '../routing/budget-store.js';
import { classifyWindow, HEADROOM_READING_MAX_AGE_MS } from '../routing/headroom.js';
import { defaultBudgetPolicy, effectiveSeatPolicy } from '../routing/policy.js';
import { assessResetOpportunity, hasResetDeadline } from '../routing/reset-pressure.js';
import { fleetQuotaPath, windowToMs } from './quota.js';
import { subscriptionUsage } from './subscription-usage.js';

export type TopSourceState = 'ready' | 'unavailable';
type JsonObject = Record<string, unknown>;
interface FleetPool { engine: string; seatId: string | null }
interface FleetAgent { poolId: string; jobId: string | null; state: string }
interface FleetJob { poolId: string; agentId: string | null; state: string }
interface FleetMap {
  pools: Record<string, FleetPool>;
  agents: Record<string, FleetAgent>;
  jobs: Record<string, FleetJob>;
}
export interface TopPool extends FleetPool {
  usage: {
    source: 'capacity' | 'subscription' | 'unknown';
    freshness: 'current' | 'stale' | 'unverified' | 'unknown';
    scope: 'seat' | 'engine' | 'unknown';
    observedAt: string | null;
    usedPercent: number | null;
  };
  quota: { scope: 'engine'; used: number | null; limit: number | null; window: string | null };
  reset: { kind: 'fixed-period' | 'weekly-deadline' | 'rolling-release' | 'balance' | 'unknown'; at: string | null };
  /** Budget/reset assessment only, not quota or dispatch authorization. */
  admission: 'eligible' | 'held' | 'unknown';
  headroomPercent: number | null;
  paceToReset: { secondsRemaining: number; headroomPercentPerHour: number } | null;
}
export interface TopSnapshot {
  schemaVersion: 'top.v1';
  observedAt: string;
  sources: { fleet: TopSourceState; capacity: TopSourceState; quota: TopSourceState; config: TopSourceState; budget: TopSourceState };
  pools: Record<string, TopPool>;
  agents: Record<string, FleetAgent>;
  jobs: Record<string, FleetJob>;
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// IDs are references, never free-form labels, prompts, paths or provider prose.
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
    !['__proto__', 'constructor', 'prototype'].includes(value) && scrubSecrets(value) === value;
}

function readJson(file: string): unknown {
  const read = readPrivateFileCapped(file, 1024 * 1024);
  if (!read || read.truncated) return null;
  try { return JSON.parse(read.text) as unknown; } catch { return null; }
}

/** Reject malformed maps as unavailable rather than silently dropping live work. */
function fleetMap(value: unknown): FleetMap | null {
  if (!object(value) || !object(value.pools) || !object(value.agents) || !object(value.jobs)) return null;
  const result: FleetMap = { pools: {}, agents: {}, jobs: {} };
  for (const map of [value.pools, value.agents, value.jobs]) {
    if (Object.keys(map).length > 10_000 || Object.keys(map).some((id) => !identifier(id))) return null;
  }
  for (const [id, pool] of Object.entries(value.pools).sort(([a], [b]) => a.localeCompare(b))) {
    if (!object(pool) || !identifier(pool.engine) || pool.seatId != null && !identifier(pool.seatId)) return null;
    result.pools[id] = { engine: pool.engine, seatId: pool.seatId as string | null ?? null };
  }
  for (const [id, agent] of Object.entries(value.agents).sort(([a], [b]) => a.localeCompare(b))) {
    if (!object(agent) || !identifier(agent.poolId) || !Object.hasOwn(result.pools, agent.poolId) ||
      !identifier(agent.state) || agent.jobId != null && !identifier(agent.jobId)) return null;
    result.agents[id] = { poolId: agent.poolId, jobId: agent.jobId as string | null ?? null, state: agent.state };
  }
  for (const [id, job] of Object.entries(value.jobs).sort(([a], [b]) => a.localeCompare(b))) {
    if (!object(job) || !identifier(job.poolId) || !Object.hasOwn(result.pools, job.poolId) ||
      !identifier(job.state) || job.agentId != null && !identifier(job.agentId)) return null;
    result.jobs[id] = { poolId: job.poolId, agentId: job.agentId as string | null ?? null, state: job.state };
  }
  for (const [id, agent] of Object.entries(result.agents)) {
    const job = agent.jobId === null ? null : result.jobs[agent.jobId];
    if (agent.jobId !== null && (!job || job.poolId !== agent.poolId || job.agentId !== null && job.agentId !== id)) return null;
  }
  for (const [id, job] of Object.entries(result.jobs)) {
    const agent = job.agentId === null ? null : result.agents[job.agentId];
    if (job.agentId !== null && (!agent || agent.poolId !== job.poolId || agent.jobId !== null && agent.jobId !== id)) return null;
  }
  return result;
}

function percent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function quotaEvents(value: unknown): { backend: string; ts: string }[] | null {
  if (!object(value) || !Array.isArray(value.events) || value.events.some((event: unknown) =>
    !object(event) || !identifier(event.backend) || typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts)))) return null;
  return value.events as { backend: string; ts: string }[];
}

export function topFleetPath(): string { return join(homedir(), '.ashlr', 'fleet', 'fleet.json'); }

export function collectTopSnapshot(options: { fleetPath?: string; nowMs?: number } = {}): TopSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const fleet = fleetMap(readJson(options.fleetPath ?? topFleetPath()));
  const capacity = readCapacitySnapshot();
  const quota = quotaEvents(readJson(fleetQuotaPath()));
  let config: AshlrConfig | null = null;
  try { config = loadConfigReadOnlyStrict(); } catch { /* Unavailable is not an unlimited quota. */ }
  const policyState = readBudgetPolicyFileState();
  const policy = policyState.state === 'ok' ? policyState.policy : defaultBudgetPolicy();
  const pools: Record<string, TopPool> = {};
  const engineCounts = new Map<string, number>();
  for (const pool of Object.values(fleet?.pools ?? {})) engineCounts.set(pool.engine, (engineCounts.get(pool.engine) ?? 0) + 1);
  for (const [id, pool] of Object.entries(fleet?.pools ?? {})) {
    const row: TopPool = {
      engine: pool.engine, seatId: pool.seatId,
      usage: { source: 'unknown', freshness: 'unknown', scope: 'unknown', observedAt: null, usedPercent: null },
      quota: { scope: 'engine', used: null, limit: null, window: null },
      reset: { kind: 'unknown', at: null }, admission: 'unknown', headroomPercent: null, paceToReset: null,
    };
    const seats = capacity?.seats.filter((seat) => seat.seatId === pool.seatId && seat.engine === pool.engine) ?? [];
    const seat = seats.length === 1 ? seats[0] : undefined;
    if (seat) {
      const observedMs = Date.parse(seat.observedAt ?? '');
      const fresh = Number.isFinite(observedMs) && observedMs <= nowMs && nowMs - observedMs <= HEADROOM_READING_MAX_AGE_MS;
      const windows = seat.windows.filter((window) => classifyWindow(seat.engine, window, nowMs) !== 'model');
      const current = fresh && windows.length > 0 && windows.every((window) => percent(window.usedPercent) &&
        (window.resetsAt === null || Date.parse(window.resetsAt) > nowMs));
      row.usage = { source: 'capacity', freshness: current ? 'current' : Number.isFinite(observedMs) && observedMs < nowMs && !fresh ? 'stale' : 'unknown', scope: 'seat',
        observedAt: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
        usedPercent: current ? Math.max(...windows.map((window) => window.usedPercent!)) : null };
      const view = assessResetOpportunity(seat, effectiveSeatPolicy(policy, seat.seatId, seat.engine), nowMs);
      row.admission = policyState.state === 'unreadable' ? 'unknown' : view.admission;
      row.reset = { kind: view.reset.kind, at: view.reset.at === null ? null : new Date(view.reset.at).toISOString() };
      row.headroomPercent = row.admission !== 'unknown' && percent(view.headroomPercent) ? view.headroomPercent : null;
      const remainingMs = Date.parse(view.reset.at ?? '') - nowMs;
      if (row.admission === 'eligible' && current && hasResetDeadline(view.reset) &&
        remainingMs > 0 && row.headroomPercent !== null) {
        row.paceToReset = { secondsRemaining: remainingMs / 1000,
          headroomPercentPerHour: row.headroomPercent * 3_600_000 / remainingMs };
      }
    } else if (pool.seatId === null && engineCounts.get(pool.engine) === 1) {
      // Engine-wide local telemetry cannot identify an account. Never assign it
      // to a bound seat or duplicate it across pools. Omit cfg to prevent writes.
      // This API has no observation timestamp, so even a future reset cannot
      // qualify freshness, admission, headroom or pace.
      const usage = subscriptionUsage(pool.engine as EngineId);
      if (usage && percent(usage.usedPercent) && typeof usage.resetsAt === 'number' && usage.resetsAt * 1000 > nowMs) {
        row.usage = { source: 'subscription', freshness: 'unverified', scope: 'engine', observedAt: null, usedPercent: usage.usedPercent };
      }
    }
    const limit = config?.foundry?.limits?.[pool.engine as EngineId];
    if (limit && Number.isSafeInteger(limit.max) && limit.max > 0 &&
      ['1m', '5m', '15m', '1h', '5h', '1d', '7d', '30d'].includes(limit.window)) {
      const cutoff = nowMs - windowToMs(limit.window);
      row.quota = { scope: 'engine', limit: limit.max, window: limit.window,
        used: quota === null ? null : quota.filter((event) => event.backend === pool.engine &&
          Date.parse(event.ts) >= cutoff && Date.parse(event.ts) <= nowMs).length };
    }
    pools[id] = row;
  }
  return { schemaVersion: 'top.v1', observedAt: new Date(nowMs).toISOString(),
    sources: { fleet: fleet === null ? 'unavailable' : 'ready', capacity: capacity === null ? 'unavailable' : 'ready',
      quota: quota === null ? 'unavailable' : 'ready', config: config === null ? 'unavailable' : 'ready',
      budget: policyState.state === 'unreadable' ? 'unavailable' : 'ready' },
    pools, agents: fleet?.agents ?? {}, jobs: fleet?.jobs ?? {} };
}
