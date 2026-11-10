import { readFableAdmission } from '../routing/fable-admission.js';
/**
 * Build and cache ashlr.world-model/v1. A warm cache hit does not re-probe
 * the roster, the desktop operator, or gh.
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listBusInboxAfter } from '../fleet/bus-inbox.js';
import { coordinationSummary } from '../agents/claim-store.js';
import { inspectBusWorkClaims } from '../fleet/bus-work-claims.js';
import { ashlrHome } from '../cloud/store.js';
import { assembleObserve, type ObserveInput } from '../observe/assemble.js';
import { parseBottlenecks, parseHumanSteps } from '../observe/contracts.js';
import { headlinesFor, parsePullExport } from '../observe/pulls.js';
import {
  bottlenecksPath,
  humanStepsPath,
  loadMergedRoster,
  loadSensorReport,
  readJsonFile,
  type ReadObserveOptions,
} from '../observe/read.js';
import type { UsageSensorReport } from '../usage/sensor-reading.js';
import type { AgentRoster } from '../fleet/agent-roster.js';
import { writeWorldExport } from './export.js';
import { loadGrowthFacts } from '../growth/read.js';
import { growthSnapshot } from '../growth/series.js';
import { projectWorldModel } from './project.js';
import { readUpdatePhase } from './update-phase.js';
import { WORLD_CACHE_TTL_MS, type WorldModel } from './types.js';
import type { ObserveSnapshot } from '../observe/types.js';

const MAX_BYTES = 1_048_576;

export interface CachedWorld extends WorldModel {
  views: { observe: ObserveSnapshot };
}

interface MemoryEntry { at: number; model: CachedWorld }

let memory: MemoryEntry | null = null;

export function clearWorldCacheForTests(): void {
  memory = null;
}

export function worldCachePath(): string {
  return join(homedir(), '.ashlr-runs', 'world', 'model.json');
}

function stamp(model: CachedWorld, hit: boolean, ageMs: number): CachedWorld {
  return { ...model, cache: { hit, ageMs, ttlMs: WORLD_CACHE_TTL_MS } };
}

async function readDisk(nowMs: number): Promise<CachedWorld | null> {
  const path = worldCachePath();
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) return null;
    const ageMs = nowMs - stat.mtimeMs;
    if (ageMs < 0 || ageMs >= WORLD_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CachedWorld;
    if (parsed?.schema !== 'ashlr.world-model/v1' || !parsed.views?.observe || !parsed.growth?.mergesPerHour) return null;
    return stamp(parsed, true, ageMs);
  } catch {
    return null;
  }
}

async function writeDisk(model: CachedWorld): Promise<void> {
  const path = worldCachePath();
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(model), { mode: 0o600 });
  } catch {
    // A cache miss next time is honest. The live object is still returned.
  }
}

async function readQueue(): Promise<{ ready: number; claimed: number } | null> {
  const path = join(homedir(), '.ashlr-runs', 'queue', 'queue.v1.json');
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { jobs?: { status?: string }[] };
    if (!Array.isArray(parsed.jobs)) return null;
    return {
      ready: parsed.jobs.filter((job) => job.status === 'READY').length,
      claimed: parsed.jobs.filter((job) => job.status === 'CLAIMED').length,
    };
  } catch {
    return null;
  }
}

async function readCi(nowMs: number): Promise<{ repos: number; medianDailyTtgSeconds: number | null; observedAt: string | null } | null> {
  const path = join(ashlrHome(), 'ci-metrics.json');
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { generatedAt?: unknown; repos?: unknown };
    const rows = Array.isArray(parsed.repos) ? parsed.repos
      : parsed.repos && typeof parsed.repos === 'object' ? Object.values(parsed.repos as Record<string, unknown>) : null;
    if (!rows) return null;
    const samples = rows.flatMap((row) => {
      const value = row && typeof row === 'object' ? (row as { daily_ttg_s?: unknown }).daily_ttg_s : null;
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [value] : [];
    });
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? null : sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    const observedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date(nowMs).toISOString();
    return { repos: rows.length, medianDailyTtgSeconds: median, observedAt };
  } catch {
    return null;
  }
}

function readClaimStore(nowMs: number): { source: 'available' | 'missing' | 'unavailable'; live: number | null } {
  try {
    const summary = coordinationSummary(undefined, nowMs);
    return { source: summary.source, live: summary.liveClaims };
  } catch {
    return { source: 'unavailable', live: null };
  }
}

function busReadable(): boolean | null {
  try {
    const page = listBusInboxAfter(0, 1);
    return page.status === 'ok' ? true : null;
  } catch {
    return null;
  }
}

type WorldReadOptions = ReadObserveOptions & { readUpdatePhase?: () => 'ok' | 'unknown' | 'failed' };

export async function buildWorldModel(options: WorldReadOptions = {}): Promise<CachedWorld> {
  const nowMs = options.nowMs ?? Date.now();
  const [humanSteps, bottlenecks, pullFile, roster, sensors, queue, ci] = await Promise.all([
    readJsonFile(options.humanStepsFile ?? humanStepsPath()),
    readJsonFile(options.bottlenecksFile ?? bottlenecksPath()),
    options.pullsFile ? readJsonFile(options.pullsFile) : Promise.resolve(null),
    options.loadRoster ? options.loadRoster().catch(() => undefined) : loadMergedRoster(),
    options.loadSensors ? options.loadSensors().catch(() => undefined) : loadSensorReport(nowMs),
    readQueue(),
    readCi(nowMs),
  ]);
  const parsedPulls = options.pulls ? { pulls: options.pulls, complete: options.pullsComplete !== false } : pullFile === null ? null : parsePullExport(pullFile);
  let claims = null as ReturnType<typeof inspectBusWorkClaims> | null;
  try { claims = (options.readClaims ?? inspectBusWorkClaims)(); } catch { claims = { source: 'unavailable', claims: [] }; }
  const steps = humanSteps === null ? null : parseHumanSteps(humanSteps);
  const blocks = bottlenecks === null ? null : parseBottlenecks(bottlenecks);
  const outcomes = parsedPulls ? headlinesFor(parsedPulls.pulls, nowMs, options.windowDays ?? 7, parsedPulls.complete) : null;
  const updatePhase = options.updatePhase ?? (options.readUpdatePhase ?? readUpdatePhase)();
  const observeInput: ObserveInput = {
    nowMs,
    windowMs: options.windowMs,
    windowDays: options.windowDays,
    roster,
    sensors,
    claims,
    humanSteps: humanSteps ?? undefined,
    bottlenecks: bottlenecks ?? undefined,
    pulls: parsedPulls?.pulls,
    pullsComplete: parsedPulls?.complete,
    pullsReason: parsedPulls ? null : 'No pull export was provided',
    updatePhase,
  };
  const observe = assembleObserve(observeInput);
  const model = projectWorldModel({
    fablePlan: readFableAdmission({ role: 'leader' }, nowMs),
    nowMs,
    sensors: isSensorReport(sensors) ? sensors : null,
    sensorRows: isSensorReport(sensors) ? sensors.lanes : [],
    roster: isRoster(roster) ? roster : null,
    claims,
    claimStore: readClaimStore(nowMs),
    busReadable: busReadable(),
    queue,
    ci,
    updatePhase,
    bottlenecks: blocks && blocks.top.length > 0 ? blocks.top.length : null,
    bottlenecksObservedAt: blocks?.top.length ? new Date(nowMs).toISOString() : null,
    stepsRemaining: steps?.stepsRemaining ?? null,
    stepsObservedAt: steps?.stepsRemaining === null || steps === null ? null : new Date(nowMs).toISOString(),
    outcomes,
    growth: growthSnapshot(await loadGrowthFacts({
      nowMs,
      ...(parsedPulls ? { pulls: parsedPulls.pulls, pullsComplete: parsedPulls.complete === true } : {}),
    })),
  });
  observe.coverage = {
    ...observe.coverage,
    unknownFields: model.blindSpots.map((spot) => ({ id: spot.id, path: spot.path, freshness: spot.freshness })),
  };
  const snapshot = { ...model, views: { observe } };
  writeWorldExport(model, { nowMs });
  return snapshot;
}

function isSensorReport(value: unknown): value is UsageSensorReport {
  return value !== null && typeof value === 'object' && Array.isArray((value as UsageSensorReport).lanes);
}

function isRoster(value: unknown): value is AgentRoster {
  return value !== null && typeof value === 'object' && Array.isArray((value as AgentRoster).sources);
}

function cacheable(options: WorldReadOptions): boolean {
  return options.force !== true && options.humanStepsFile === undefined && options.bottlenecksFile === undefined
    && options.pullsFile === undefined && options.pulls === undefined && options.loadRoster === undefined
    && options.loadSensors === undefined && options.readClaims === undefined && options.updatePhase === undefined
    && options.readUpdatePhase === undefined;
}

export async function readWorldModel(options: WorldReadOptions & { force?: boolean } = {}): Promise<CachedWorld> {
  const nowMs = options.nowMs ?? Date.now();
  if (cacheable(options) && memory && nowMs - memory.at >= 0 && nowMs - memory.at < WORLD_CACHE_TTL_MS) {
    return stamp(memory.model, true, nowMs - memory.at);
  }
  if (cacheable(options)) {
    const disk = await readDisk(nowMs);
    if (disk) {
      memory = { at: nowMs - disk.cache.ageMs, model: disk };
      return disk;
    }
  }
  const model = await buildWorldModel(options);
  if (cacheable(options)) {
    memory = { at: nowMs, model };
    await writeDisk(model);
  }
  return model;
}
