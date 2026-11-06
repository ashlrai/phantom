/** Memory benchmark metadata. RSS is bytes for the sampled job process tree,
 * not the supervisor's lifetime maxRSS. Missing measurements stay unknown.
 * Input is an explicit export from the job runner/memguard; never read logs,
 * command lines, environment variables or infer a merge from PR creation.
 */
import type { GenAiSpan } from '../types.js';

export interface MemorySample {
  rssBytes: number;
  /** Repeated PAUSE samples in one episode count as one event. */
  memguard: 'RUN' | 'PAUSE';
}
export interface MemoryJob {
  jobId: string;
  samples: MemorySample[];
  /** Set only after the runner has observed a confirmed merge. */
  mergedPr?: { repo: string; number: number };
}
export interface MemoryMeasurement {
  peakRssBytes: number | null;
  sampleCount: number;
  pauseEvents: number;
}
export interface MemoryBenchmark {
  jobs: (MemoryMeasurement & { jobId: string })[];
  mergedPrs: (MemoryMeasurement & { repo: string; number: number; jobs: number })[];
  /** Sum of measured job peaks / distinct merged PRs. Includes failed jobs. */
  peakBytesPerMergedPr: number | null;
}

const MAX_JOBS = 10_000;
const MAX_SAMPLES = 100_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const natural = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate untrusted runner exports and copy an allowlist, dropping all content. */
export function parseMemoryJobs(input: unknown): MemoryJob[] {
  if (!Array.isArray(input) || input.length > MAX_JOBS) throw new Error('Expected at most 10000 memory jobs');
  const seen = new Set<string>();
  let samples = 0;
  return input.map(value => {
    if (!record(value) || typeof value.jobId !== 'string' || !ID.test(value.jobId) || seen.has(value.jobId)) {
      throw new Error('Invalid or duplicate memory job identifier');
    }
    seen.add(value.jobId);
    if (!Array.isArray(value.samples) || (samples += value.samples.length) > MAX_SAMPLES) throw new Error('Expected at most 100000 memory samples');
    const job: MemoryJob = { jobId: value.jobId, samples: value.samples.map(sample => {
      if (!record(sample) || !natural(sample.rssBytes) || (sample.memguard !== 'RUN' && sample.memguard !== 'PAUSE')) throw new Error('Invalid memory sample');
      return { rssBytes: sample.rssBytes, memguard: sample.memguard };
    }) };
    if (value.mergedPr !== undefined) {
      const pr = value.mergedPr;
      if (!record(pr) || typeof pr.repo !== 'string' || !REPO.test(pr.repo) || !natural(pr.number) || pr.number === 0) throw new Error('Invalid merged PR identity');
      job.mergedPr = { repo: pr.repo.toLowerCase(), number: pr.number };
    }
    return job;
  });
}

export function buildMemoryBenchmark(input: unknown): MemoryBenchmark {
  const source = parseMemoryJobs(input);
  const merged = new Map<string, MemoryBenchmark['mergedPrs'][number]>();
  let total = 0;
  const jobs = source.map(job => {
    let peakRssBytes: number | null = null;
    let pauseEvents = 0;
    let paused = false;
    for (const sample of job.samples) {
      peakRssBytes = Math.max(peakRssBytes ?? 0, sample.rssBytes);
      if (sample.memguard === 'PAUSE' && !paused) pauseEvents++;
      paused = sample.memguard === 'PAUSE';
    }
    total += peakRssBytes ?? 0;
    if (!Number.isSafeInteger(total)) throw new Error('Memory aggregate exceeds safe integer range');
    const measurement = { peakRssBytes, sampleCount: job.samples.length, pauseEvents };
    if (job.mergedPr) {
      const key = `${job.mergedPr.repo}#${job.mergedPr.number}`;
      const pr = merged.get(key) ?? { ...job.mergedPr, peakRssBytes: null, sampleCount: 0, pauseEvents: 0, jobs: 0 };
      if (peakRssBytes !== null) pr.peakRssBytes = Math.max(pr.peakRssBytes ?? 0, peakRssBytes);
      pr.sampleCount += measurement.sampleCount;
      pr.pauseEvents += pauseEvents;
      pr.jobs++;
      merged.set(key, pr);
    }
    return { jobId: job.jobId, ...measurement };
  });
  return { jobs, mergedPrs: [...merged.values()], peakBytesPerMergedPr: merged.size > 0 && jobs.every(job => job.peakRssBytes !== null) ? total / merged.size : null };
}

/** Existing telemetry sink handles credentials, opt-in and bounded delivery. */
export function memoryBenchmarkSpans(report: MemoryBenchmark, at: string): GenAiSpan[] {
  return [
    ...report.jobs.map(job => ({ id: job.jobId, scope: 'job' as const, measurement: job })),
    ...report.mergedPrs.map(pr => ({ id: `${pr.repo}#${pr.number}`, scope: 'merged_pr' as const, measurement: pr })),
  ].map(({ id, scope, measurement }) => ({
    name: 'phantom.memory_benchmark', runId: id, provider: 'phantom', model: 'none', tier: 'none',
    tokensIn: 0, tokensOut: 0, estCostUsd: 0, status: 'done', startTs: at, endTs: at,
    memory: { scope, peakRssBytes: measurement.peakRssBytes, sampleCount: measurement.sampleCount, pauseEvents: measurement.pauseEvents },
  }));
}

export function memoryReportLine(report: MemoryBenchmark): string {
  const peaks = report.jobs.flatMap(job => job.peakRssBytes === null ? [] : [job.peakRssBytes]);
  const mib = (n: number | null) => n === null ? 'unknown' : `${(n / 1048576).toFixed(1)} MiB`;
  return `Memory: ${report.jobs.length} jobs (${peaks.length} measured), ${report.mergedPrs.length} merged PRs; peak RSS ${mib(peaks.length ? Math.max(...peaks) : null)}; sum job peaks/merged PR ${mib(report.peakBytesPerMergedPr)}; memguard PAUSE ${report.jobs.reduce((sum, job) => sum + job.pauseEvents, 0)}`;
}
