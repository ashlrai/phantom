/** Batch draft-job precheck: sequential reports over a shared git-fact cache. No process spawn lives here. */
import { precheckJob, type JobPrecheckGit } from './job-precheck.js';

export const JOB_PRECHECK_BATCH_MAX = 20;

export type JobPrecheckReport = Awaited<ReturnType<typeof precheckJob>>;

/** Exactly one of report/error is set. An error is never a verdict. */
export interface JobPrecheckBatchEntry {
  file: string;
  report?: JobPrecheckReport;
  error?: string;
}

export interface JobPrecheckBatchCounts {
  fresh: number;
  'partly-on-master': number;
  'likely-done': number;
  errors: number;
}

/** One implementation path at least two distinct drafts name. Evidence only, never a refusal. */
export interface JobPrecheckCollision {
  path: string;
  files: string[];
}

export interface JobPrecheckBatchResult {
  entries: JobPrecheckBatchEntry[];
  counts: JobPrecheckBatchCounts;
  collisions: JobPrecheckCollision[];
}

export interface JobPrecheckBatchDeps {
  readFile: (path: string) => Promise<string>;
  git: JobPrecheckGit;
  resolveJobId?: (file: string) => string;
}

/**
 * Per-invocation shared cache: each path's exists/lastCommit promise is created
 * once, so overlapping drafts probe a fact a single time. Rejected promises are
 * cached too, keeping a failed lookup a failure for every draft instead of
 * letting it look like a missing path.
 */
export function cachingJobPrecheckGit(git: JobPrecheckGit): JobPrecheckGit {
  const share = <T>(cache: Map<string, Promise<T>>, path: string, probe: () => Promise<T>): Promise<T> => {
    let pending = cache.get(path);
    if (!pending) {
      pending = Promise.resolve().then(probe);
      cache.set(path, pending);
    }
    return pending;
  };
  const exists = new Map<string, Promise<boolean>>();
  const commits = new Map<string, Promise<{ sha: string; subject: string } | null>>();
  return {
    exists: (path) => share(exists, path, () => git.exists(path)),
    lastCommit: (path) => share(commits, path, () => git.lastCommit(path)),
  };
}

function probeError(err: unknown): string {
  const message = err instanceof Error ? err.message.split('\n')[0] : '';
  return (message || 'git precheck failed').slice(0, 300);
}

/** Mirrors the verdict's test/spec exclusion in job-precheck.ts: collisions track implementation files. */
function isTestPath(path: string): boolean {
  return path.startsWith('test/') || (path.startsWith('src/') && /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(path));
}

/**
 * Checks drafts in order; one draft's failure never skips the rest.
 * Collisions come from successful reports' non-test facts, sorted by path with
 * draft filenames in input order. A failed draft contributes no inferred facts.
 */
export async function precheckJobBatch(
  files: readonly string[],
  deps: JobPrecheckBatchDeps,
): Promise<JobPrecheckBatchResult> {
  const git = cachingJobPrecheckGit(deps.git);
  const entries: JobPrecheckBatchEntry[] = [];
  const counts: JobPrecheckBatchCounts = { fresh: 0, 'partly-on-master': 0, 'likely-done': 0, errors: 0 };
  const shared = new Map<string, Set<string>>();
  for (const file of files) {
    let markdown: string;
    try {
      markdown = await deps.readFile(file);
    } catch {
      entries.push({ file, error: `cannot read ${file}` });
      counts.errors += 1;
      continue;
    }
    try {
      const report = await precheckJob(markdown, git, { jobId: deps.resolveJobId?.(file) });
      entries.push({ file, report });
      counts[report.verdict] += 1;
      for (const fact of report.facts) {
        if (isTestPath(fact.path)) continue;
        let owners = shared.get(fact.path);
        if (!owners) shared.set(fact.path, (owners = new Set()));
        owners.add(file);
      }
    } catch (err) {
      entries.push({ file, error: probeError(err) });
      counts.errors += 1;
    }
  }
  const collisions: JobPrecheckCollision[] = [...shared]
    .filter(([, owners]) => owners.size > 1)
    .map(([path, owners]) => ({ path, files: [...owners] }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, counts, collisions };
}
