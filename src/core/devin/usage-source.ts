/** Display-only resource evidence. Never authorizes launches or spending. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDevinBillingUsage } from './api-billing.js';

export interface DevinResourceV1 {
  schema: 'resource.v1';
  lane: 'devin';
  source: 'acu' | 'walltime';
  unit: 'acu' | 'seconds';
  used: number | null;
  left: null;
  reset: null;
  burnRate: number | null;
  burnRateUnit: 'acu/hour' | 'seconds/hour';
  windowStart: string;
  observedAt: string;
  status: 'ready' | 'partial' | 'unavailable';
}

export interface DevinUsageOptions {
  now?: Date;
  jobsPath?: string;
  orgId?: string;
  /** Only supplied by Phantom Secrets via `phantom exec --`, never CLI argv. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  readJobs?: (path: string) => Promise<string>;
}

/** Completed job wall time, clipped to the reporting window. Invalid rows are unknown. */
export function sumDevinJobSeconds(jsonl: string, start: number, end: number): { used: number; partial: boolean } {
  let used = 0;
  let partial = false;
  const seen = new Set<string>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) { partial = true; continue; }
      const job = row as Record<string, unknown>;
      if (job['lane'] !== 'devin') continue;
      const started = typeof job['startedAt'] === 'string' ? Date.parse(job['startedAt']) : NaN;
      const ended = typeof job['finishedAt'] === 'string' ? Date.parse(job['finishedAt']) : NaN;
      if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started || ended > end) {
        partial = true;
        continue;
      }
      const id = typeof job['jobId'] === 'string' ? job['jobId'] : null;
      if (id !== null && seen.has(id)) continue;
      if (id !== null) seen.add(id);
      used += Math.max(0, Math.min(end, ended) - Math.max(start, started)) / 1000;
    } catch { partial = true; }
  }
  return { used, partial };
}

export async function readDevinResource(options: DevinUsageOptions = {}): Promise<DevinResourceV1> {
  const end = (options.now ?? new Date()).getTime();
  // A rolling 24-hour observation window is not a subscription reset period.
  const start = end - 86_400_000;
  const common = {
    schema: 'resource.v1' as const, lane: 'devin' as const,
    left: null, reset: null, windowStart: new Date(start).toISOString(), observedAt: new Date(end).toISOString(),
  };
  const used = await readDevinBillingUsage({
    env: options.env ?? process.env, orgId: options.orgId,
    start, end, fetch: options.fetch,
  });
  if (used !== null) return {
    ...common, source: 'acu', unit: 'acu', used, burnRate: used / 24,
    burnRateUnit: 'acu/hour', status: 'ready',
  };
  try {
    const path = options.jobsPath ?? join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
    const jobs = await (options.readJobs ?? (file => readFile(file, 'utf8')))(path);
    const result = sumDevinJobSeconds(jobs, start, end);
    return {
      ...common, source: 'walltime', unit: 'seconds', used: result.used,
      burnRate: result.used / 24, burnRateUnit: 'seconds/hour', status: result.partial ? 'partial' : 'ready',
    };
  } catch {
    return { ...common, source: 'walltime', unit: 'seconds', used: null, burnRate: null, burnRateUnit: 'seconds/hour', status: 'unavailable' };
  }
}
