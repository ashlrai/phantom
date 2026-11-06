#!/usr/bin/env -S npx tsx
/**
 * Compare observed changed paths across fleet jobs.
 * Usage: npx tsx examples/agents/job-edit-collisions.ts --job ID --job ID [--job ID ...]
 * Supply 2–20 distinct jobs. Empty intersections mean no observed collisions;
 * they establish no absence of collisions unless complete is true. Exit codes:
 * 0 complete report, 1 partial report, 2 invalid arguments.
 */
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../../src/core/fleet/runs-job-changes.js';
import { isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';

export interface JobEditCollisionsDependencies {
  readChanges?: (job: string) => Promise<FleetJobChangesV1>;
  now?: () => Date;
  write?: (text: string) => void;
}

type Source = {
  job: string;
  generatedAt: string | null;
  state: FleetJobChangesV1['state'] | 'unavailable';
  truncated: boolean | null;
};

function normalizedPath(path: string): string | null {
  if (!path || path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) return null;
  const normalized = posix.normalize(path);
  return normalized === '.' ? null : normalized;
}

/** Emit one JSON report; readers, clock, and output can be supplied by the caller. */
export async function runJobEditCollisions(args: readonly string[], deps: JobEditCollisionsDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  if (args.length === 1 && args[0] === '--help') {
    write('Usage: npx tsx examples/agents/job-edit-collisions.ts --job ID --job ID [--job ID ...]\n');
    return 0;
  }
  const jobs: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const job = args[i + 1] ?? '';
    if (args[i] !== '--job' || !isFleetJobId(job) || jobs.includes(job)) {
      emit({ schema: 'fleet.job-edit-collisions.error.v1', error: 'invalid_arguments' });
      return 2;
    }
    jobs.push(job);
  }
  if (jobs.length < 2 || jobs.length > 20) {
    emit({ schema: 'fleet.job-edit-collisions.error.v1', error: 'invalid_arguments' });
    return 2;
  }

  const read = deps.readChanges ?? getFleetJobChanges;
  const results: Array<FleetJobChangesV1 | null> = Array.from({ length: jobs.length }, () => null);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      try { results[index] = await read(jobs[index]!); } catch { /* Preserve other sources. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => worker()));

  let complete = true;
  const paths = new Map<string, Set<string>>();
  const sources: Source[] = jobs.map((job, index) => {
    const result = results[index];
    if (!result) {
      complete = false;
      return { job, generatedAt: null, state: 'unavailable', truncated: null };
    }
    if (result.state !== 'live' || result.truncated) complete = false;
    for (const file of result.files) {
      const path = normalizedPath(file.path);
      if (!path) { complete = false; continue; }
      const owners = paths.get(path) ?? new Set<string>();
      owners.add(job);
      paths.set(path, owners);
    }
    return { job, generatedAt: result.generatedAt, state: result.state, truncated: result.truncated };
  });
  const intersections = [...paths.entries()]
    .filter(([, owners]) => owners.size > 1)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, owners]) => ({ path, jobs: [...owners] }));
  emit({ schema: 'fleet.job-edit-collisions.v1', generatedAt: (deps.now ?? (() => new Date()))().toISOString(), complete, sources, intersections });
  return complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobEditCollisions(process.argv.slice(2));
}
