/** Branches that were pushed but whose publication aborted at the default-branch fetch. Local logs only; no network. */
import { readdir } from 'node:fs/promises';
import { findPublishAbort, PUBLISH_LOG_NAME, readPublishLogLines } from './publish-log.js';

export interface StrandedBranch {
  job: string;
  branch: string;
  /** `result-abort` is `RESULT ABORT default-fetch`; `bare-abort` is the older `ABORT default-fetch`. */
  shape: 'result-abort' | 'bare-abort';
}
export interface StrandedBranchesReport {
  schema: 'jobs.stranded.v1';
  readOnly: true;
  /** `unknown` when any publish log could not be read; those jobs are listed in `unreadable`, never counted as clean. */
  status: 'ok' | 'unknown';
  branches: StrandedBranch[];
  unreadable: string[];
}

/** Scan `<runsDir>/*.publish` for a confirmed push followed by `ABORT default-fetch`. Sorted by job. */
export async function readStrandedBranches(runsDir: string): Promise<StrandedBranchesReport> {
  const branches: StrandedBranch[] = [], unreadable: string[] = [];
  for (const name of (await readdir(runsDir)).sort()) {
    if (!PUBLISH_LOG_NAME.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -'.publish'.length), branch = `codex-bridge/${job}`;
    try {
      const abort = findPublishAbort(await readPublishLogLines(runsDir, name), branch);
      if (abort?.reason === 'default-fetch') branches.push({ job, branch, shape: abort.line.startsWith('RESULT ') ? 'result-abort' : 'bare-abort' });
    } catch { unreadable.push(job); }
  }
  return { schema: 'jobs.stranded.v1', readOnly: true, status: unreadable.length ? 'unknown' : 'ok', branches, unreadable };
}
