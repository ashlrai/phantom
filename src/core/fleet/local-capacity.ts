/**
 * `phm local capacity`: how many local-model workers fit in free memory right now (schema `local.capacity.v1`).
 * oMLX went down twice on Nov 20 with 7-8 local workers running, because the local lane's target was a fixed number
 * that ignored memory. This is the one answer autofill, the lane planner and the Pools card share.
 *
 * Read-only: it reads vm_stat and the process table and never starts, stops or resizes anything.
 *   usable  = free memory * (1 - 30% safety margin)
 *   workers = floor(usable / memory per worker), clamped to 0..lane ceiling
 * Memory per worker is the median of recent local worker samples (at least 3, never under 1 GB each, so one tiny
 * client process cannot promise room the model server does not have), else `local.worker_gb` (default 6).
 * Free memory that cannot be read gives `workers: null` ("unknown"); callers then leave the lane alone.
 */
import { totalmem } from 'node:os';
import { parseVmStat } from '../run/host-headroom.js';
import { createConfigReader } from './dynconfig.js';
import { defaultRunsDir, runRead } from './host-top.js';
import { readLaneTargets } from './runs-lane-targets.js';

export const LOCAL_CAPACITY_SCHEMA = 'local.capacity.v1';
export const LOCAL_LANE = 'codex-local';
export const SAFETY_MARGIN = 0.3;
export const DEFAULT_WORKER_GB = 6;
/** Fewer samples than this are noise; the configured default is used instead. */
export const MIN_SAMPLES = 3;
/** A sample under this is a client process, not a model's footprint, and is raised to it. */
export const MIN_WORKER_GB = 1;
const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface LocalCapacityReport {
  schema: typeof LOCAL_CAPACITY_SCHEMA;
  asOf: string;
  /** Workers that fit; null when free memory is unknown. */
  workers: number | null;
  /** What memory alone allows, before the lane ceiling; null when unknown. */
  fitsByMemory: number | null;
  freeGb: number | null;
  perWorkerGb: number;
  perWorkerSource: 'samples' | 'default';
  sampleCount: number;
  safetyMargin: number;
  /** Free memory left after the workers it allows; null when unknown. */
  spareGb: number | null;
  /** Lane ceiling the count was clamped to; null when the ceiling is unknown (no clamp). */
  ceiling: number | null;
  /** One plain sentence. */
  summary: string;
}

export interface LocalCapacityInput {
  freeGb: number | null;
  /** Resident GB of recent local workers; junk values are ignored. */
  samplesGb?: readonly number[];
  defaultWorkerGb?: number;
  ceiling?: number | null;
  now?: number;
}

const plural = (n: number): string => `${n} local worker${n === 1 ? '' : 's'}`;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Pure: numbers in, one report out. */
export function computeLocalCapacity(input: LocalCapacityInput): LocalCapacityReport {
  const samples = (input.samplesGb ?? []).filter(v => Number.isFinite(v) && v > 0);
  const fallback = input.defaultWorkerGb !== undefined && Number.isFinite(input.defaultWorkerGb) && input.defaultWorkerGb > 0
    ? input.defaultWorkerGb : DEFAULT_WORKER_GB;
  const measured = samples.length >= MIN_SAMPLES;
  const perWorkerGb = round1(measured ? Math.max(MIN_WORKER_GB, median(samples)) : fallback);
  const ceiling = input.ceiling !== undefined && input.ceiling !== null && Number.isSafeInteger(input.ceiling) && input.ceiling >= 0 ? input.ceiling : null;
  const base = {
    schema: LOCAL_CAPACITY_SCHEMA, asOf: new Date(input.now ?? Date.now()).toISOString(), perWorkerGb,
    perWorkerSource: measured ? 'samples' : 'default', sampleCount: samples.length, safetyMargin: SAFETY_MARGIN, ceiling,
  } as const;
  const free = input.freeGb;
  if (free === null || !Number.isFinite(free) || free < 0) {
    return { ...base, workers: null, fitsByMemory: null, freeGb: null, spareGb: null,
      summary: 'Local worker room is unknown (free memory could not be read), so the lane target is left as it is.' };
  }
  const fitsByMemory = Math.floor((free * (1 - SAFETY_MARGIN)) / perWorkerGb);
  const workers = Math.max(0, ceiling === null ? fitsByMemory : Math.min(fitsByMemory, ceiling));
  const spareGb = round1(free - workers * perWorkerGb);
  const facts = `${round1(free)} GB free, about ${perWorkerGb} GB each`;
  const summary = workers === 0
    ? `No room for a local worker right now (${facts}, keeping ${Math.round(SAFETY_MARGIN * 100)}% spare)`
    : `Room for ${plural(workers)} (${facts}, keeping ${spareGb} GB spare${ceiling !== null && fitsByMemory > ceiling ? `; lane ceiling is ${ceiling}` : ''})`;
  return { ...base, workers, fitsByMemory, freeGb: round1(free), spareGb, summary };
}

/** Local workers' resident GB: process rows under the worktree root, attributed per job, for jobs on the local lane. */
export async function readWorkerSamplesGb(deps: { root?: string; ps?: () => Promise<string>; workers?: () => Promise<{ job: string; lane: string }[]> } = {}): Promise<number[]> {
  try {
    const [{ listLiveWorkers }, procs, { homedir }, { join }] = await Promise.all([
      import('./runs-live-workers.js'), import('../../cli/fleet-procs.js'), import('node:os'), import('node:path')]);
    const live = deps.workers ? await deps.workers() : (await listLiveWorkers()).workers;
    const local = new Set(live.filter(w => w.lane === LOCAL_LANE).map(w => w.job));
    if (local.size === 0) return [];
    const ps = deps.ps ?? (async () => (await runRead('/bin/ps', procs.PROCS_PS_ARGS)) ?? '');
    const view = procs.summarizeJobProcs(procs.parsePsRows(await ps()), deps.root ?? join(homedir(), 'Projects', 'ashlrai', 'wt'), Date.now());
    return view.jobs.filter(job => local.has(job.job) && job.rssMb > 0).map(job => job.rssMb / 1024);
  } catch { return []; }
}

export interface LocalCapacityDeps {
  runsDir?: string;
  totalBytes?: number;
  /** Text of `vm_stat`, or null. Tests inject. */
  vmStat?: () => Promise<string | null>;
  samplesGb?: () => Promise<number[]>;
  /** The local lane's ceiling from slots.json, or null. */
  ceiling?: () => Promise<number | null>;
  defaultWorkerGb?: () => Promise<number | undefined>;
  now?: () => number;
}

/** The one impure entry. Never throws and never acts. */
export async function readLocalCapacity(deps: LocalCapacityDeps = {}): Promise<LocalCapacityReport> {
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const quiet = async <T,>(read: () => Promise<T>, fallback: T): Promise<T> => { try { return await read(); } catch { return fallback; } };
  const [vmText, samplesGb, ceiling, defaultWorkerGb] = await Promise.all([
    quiet(deps.vmStat ?? (() => runRead('/usr/bin/vm_stat', [])), null),
    quiet(deps.samplesGb ?? (() => readWorkerSamplesGb()), []),
    quiet(deps.ceiling ?? (async () => (await readLaneTargets({ runsDir })).lanes.find(l => l.lane === LOCAL_LANE)?.ceiling ?? null), null),
    quiet(deps.defaultWorkerGb ?? (async () => {
      const value = (await createConfigReader({ runsDir }).resolve()).values['local.worker_gb'];
      return typeof value === 'number' ? value : undefined;
    }), undefined),
  ]);
  const total = deps.totalBytes ?? totalmem();
  const pct = vmText ? parseVmStat(vmText, total) : null;
  return computeLocalCapacity({ freeGb: pct === null ? null : (pct / 100) * total / GB, samplesGb, defaultWorkerGb, ceiling, now: (deps.now ?? Date.now)() });
}

/** The local lane's target, held to the room memory allows. Unknown room leaves the target alone. */
export function clampLocalTarget(target: number | null, report: Pick<LocalCapacityReport, 'workers'>): number | null {
  return target === null || report.workers === null ? target : Math.min(target, report.workers);
}
