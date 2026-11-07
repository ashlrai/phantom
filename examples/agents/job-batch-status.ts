#!/usr/bin/env -S npx tsx
/**
 * Summarize artifact status for a batch of fleet jobs, in request order.
 * Usage: npx tsx examples/agents/job-batch-status.ts --job ID [--job ID ...]
 * Repeat --job 1 to 20 times; a repeated id is read once and reported once, in
 * first-given order. At most four detail reads run at once. A job whose read
 * fails reports state "unavailable"; other jobs still report. Exit codes:
 * 0 every job read, 1 at least one job unavailable, 2 invalid arguments.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';

const USAGE = `Usage: npx tsx examples/agents/job-batch-status.ts --job ID [--job ID ...]

Reads each job's fleet.job.v1 detail and prints one ordered JSON summary per
job: id, artifact state, lane and model, publish PR URL and TEST line, log
source, and per-source health. Repeat --job 1 to 20 times; a repeated id is
read once and reported once, in first-given order. At most four detail reads
run at once. A job whose read fails reports state "unavailable"; the other
jobs still report. No log text, file paths, or process-liveness claims are
emitted; a pid in the launch record is not evidence a worker is alive.
Exit codes: 0 every job read, 1 at least one job unavailable or an unexpected
failure, 2 invalid arguments.
Errors are JSON: {"schema":"fleet.job-batch-status.error.v1","error":"invalid_arguments"|"reader_unavailable"}.
`;

const MAX_JOB_FLAGS = 20;
const MAX_PARALLEL_READS = 4;

export interface JobBatchStatusDependencies {
  readDetail?: (job: string) => Promise<FleetJobDetailV1>;
  now?: () => Date;
  write?: (text: string) => void;
}

interface JobStatus {
  job: string;
  state: FleetJobDetailV1['state'] | 'unavailable';
  lane: string | null;
  model: string | null;
  publish: { prUrl: string | null; testLine: string | null } | null;
  logSource: FleetJobDetailV1['log']['source'] | null;
  sources: FleetJobDetailV1['sources'] | null;
}

/** 1–20 `--job ID` pairs; repeated ids collapse to their first position. */
function parseArgs(args: readonly string[]): string[] | null {
  if (args.length === 0 || args.length % 2 !== 0 || args.length / 2 > MAX_JOB_FLAGS) return null;
  const jobs: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const job = args[i + 1]!;
    if (args[i] !== '--job' || !isFleetJobId(job)) return null;
    if (!seen.has(job)) {
      seen.add(job);
      jobs.push(job);
    }
  }
  return jobs;
}

/** Emit one JSON report; reader, clock, and output can be supplied by the caller. */
export async function runJobBatchStatus(args: readonly string[], deps: JobBatchStatusDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  if (args.length === 1 && args[0] === '--help') {
    write(USAGE);
    return 0;
  }
  const jobs = parseArgs(args);
  if (!jobs) {
    emit({ schema: 'fleet.job-batch-status.error.v1', error: 'invalid_arguments' });
    return 2;
  }

  const read = deps.readDetail ?? getFleetJobDetail;
  const details: Array<FleetJobDetailV1 | null> = jobs.map(() => null);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      try { details[index] = await read(jobs[index]!); } catch { /* A failed read stays unavailable; other jobs still report. */ }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_READS, jobs.length) }, () => worker()));
  } catch {
    emit({ schema: 'fleet.job-batch-status.error.v1', error: 'reader_unavailable' });
    return 1;
  }

  let complete = true;
  const statuses: JobStatus[] = jobs.map((job, index) => {
    const detail = details[index];
    if (!detail) {
      complete = false;
      return { job, state: 'unavailable', lane: null, model: null, publish: null, logSource: null, sources: null };
    }
    return {
      job, state: detail.state, lane: detail.lane, model: detail.model,
      publish: detail.publish ? { prUrl: detail.publish.prUrl, testLine: detail.publish.testLine } : null,
      logSource: detail.log.source, sources: detail.sources,
    };
  });
  emit({ schema: 'fleet.job-batch-status.v1', generatedAt: (deps.now ?? (() => new Date()))().toISOString(), complete, jobs: statuses });
  return complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobBatchStatus(process.argv.slice(2));
}
