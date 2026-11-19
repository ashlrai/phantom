/** Branches that were pushed but whose publication aborted at the default-branch fetch. Local logs only; no network. */
import { readdir } from 'node:fs/promises';
import { findPublishAbort, PUBLISH_LOG_NAME, readPublishLogLines } from './publish-log.js';

export interface StrandedBranch {
  job: string;
  branch: string;
  /** `result-abort` is `RESULT ABORT default-fetch`; `bare-abort` is the older `ABORT default-fetch`. */
  shape: 'result-abort' | 'bare-abort';
  /** Safe to run repeatedly: opens a PR only when none exists for the branch. */
  recover: string;
}
export interface RecoveredBranch {
  job: string;
  branch: string;
  /** PR URL from the `RESULT PR` line that followed the abort. */
  pr: string;
}
export interface StrandedBranchesReport {
  schema: 'jobs.stranded.v1';
  readOnly: true;
  /** `unknown` when any publish log could not be read; those jobs are listed in `unreadable`, never counted as clean. */
  status: 'ok' | 'unknown';
  branches: StrandedBranch[];
  /** Aborted at the default fetch earlier, but a later `RESULT PR` shows the PR exists. Nothing to do. */
  recovered: RecoveredBranch[];
  unreadable: string[];
}

/** One command that is a no-op when the branch already has a PR (any state). */
export function recoverCommand(branch: string): string {
  return `gh pr view '${branch}' >/dev/null 2>&1 || gh pr create --head '${branch}' --fill`;
}

/** PR URL when a default-fetch abort after the push was followed by `RESULT PR <url>`. */
function recoveredPr(lines: string[], branch: string): string | null {
  const pushed = lines.findIndex(line => line.trim().replace(/^remote:\s*/, '').startsWith(`Create a pull request for '${branch}'`));
  const abort = lines.findIndex((line, i) => i > pushed && pushed >= 0 && /^(?:RESULT )?ABORT\s+default-fetch\s*$/.test(line));
  for (let i = lines.length - 1; abort >= 0 && i > abort; i--) {
    const pr = /^RESULT PR (\S+)\s*$/.exec(lines[i]!);
    if (pr) return pr[1]!;
  }
  return null;
}

/** Scan `<runsDir>/*.publish` for a confirmed push followed by `ABORT default-fetch`. Sorted by job. */
export async function readStrandedBranches(runsDir: string): Promise<StrandedBranchesReport> {
  const branches: StrandedBranch[] = [], recovered: RecoveredBranch[] = [], unreadable: string[] = [];
  for (const name of (await readdir(runsDir)).sort()) {
    if (!PUBLISH_LOG_NAME.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -'.publish'.length), branch = `codex-bridge/${job}`;
    try {
      const lines = await readPublishLogLines(runsDir, name), abort = findPublishAbort(lines, branch);
      if (abort?.reason === 'default-fetch') branches.push({ job, branch, shape: abort.line.startsWith('RESULT ') ? 'result-abort' : 'bare-abort', recover: recoverCommand(branch) });
      else { const pr = recoveredPr(lines, branch); if (pr) recovered.push({ job, branch, pr }); }
    } catch { unreadable.push(job); }
  }
  return { schema: 'jobs.stranded.v1', readOnly: true, status: unreadable.length ? 'unknown' : 'ok', branches, recovered, unreadable };
}
