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

export interface JobPrecheckBatchResult {
  entries: JobPrecheckBatchEntry[];
  counts: JobPrecheckBatchCounts;
}

export interface JobPrecheckBatchDeps {
  readFile: (path: string) => Promise<string>;
  git: JobPrecheckGit;
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

/** Checks drafts in order; one draft's failure never skips the rest. */
export async function precheckJobBatch(
  files: readonly string[],
  deps: JobPrecheckBatchDeps,
): Promise<JobPrecheckBatchResult> {
  const git = cachingJobPrecheckGit(deps.git);
  const entries: JobPrecheckBatchEntry[] = [];
  const counts: JobPrecheckBatchCounts = { fresh: 0, 'partly-on-master': 0, 'likely-done': 0, errors: 0 };
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
      const report = await precheckJob(markdown, git);
      entries.push({ file, report });
      counts[report.verdict] += 1;
    } catch (err) {
      entries.push({ file, error: probeError(err) });
      counts.errors += 1;
    }
  }
  return { entries, counts };
}
