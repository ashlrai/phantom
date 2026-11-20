/** Branches that were pushed but whose publication then aborted (usually the default-branch fetch). Local logs only; no network. */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findPublishAbort, PUBLISH_LOG_NAME, readPublishLogLines } from './publish-log.js';

export interface StrandedBranch {
  job: string;
  branch: string;
  /** `result-abort` is `RESULT ABORT default-fetch`; `bare-abort` is the older `ABORT default-fetch`. */
  shape: 'result-abort' | 'bare-abort';
  /** Abort reason after `ABORT`, e.g. `default-fetch`; `unknown` when the log gave none. */
  reason: string;
  /** `owner/name` from the push confirmation link; null (unknown) when the log has no link. */
  repo: string | null;
  /** Hours since the log was last written; null (unknown) when `now` is not known. */
  ageHours: number | null;
  /** Files changed, only when the log printed a git summary; null (unknown) otherwise. */
  filesChanged: number | null;
  /** One plain next step for a person or agent. Nothing here pushes or opens a PR. */
  next: string;
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
  /** Window applied by `--since`, in hours; null when every log was considered. */
  sinceHours: number | null;
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

/** `24h`, `90m` or `2d` as hours; null when it is not one of those. */
export function parseSinceHours(value: string): number | null {
  const m = /^(\d{1,5})([mhd])$/.exec(value);
  if (!m || Number(m[1]) === 0) return null;
  return Number(m[1]) * { m: 1 / 60, h: 1, d: 24 }[m[2] as 'm' | 'h' | 'd'];
}

export function nextStep(branch: string): string {
  return `Re-queue as a recovery job: fetch ${branch} from the fork and re-publish.`;
}

/** One plain line for the hourly digest; null when nothing is stranded (or the read failed). */
export function strandedDigestLine(report: Pick<StrandedBranchesReport, 'branches'> | null): string | null {
  const n = report?.branches.length ?? 0;
  return n > 0 ? `stranded: ${n} finished job${n === 1 ? '' : 's'} pushed a branch but opened no PR (phm jobs stranded)` : null;
}

function repoOf(lines: string[], from: number): string | null {
  for (const line of lines.slice(from, from + 4)) {
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/new\//.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

function filesOf(lines: string[]): number | null {
  for (const line of lines) { const m = /\b(\d+) files? changed\b/.exec(line); if (m) return Number(m[1]); }
  return null;
}

/** PR URL when an abort after the push was followed by `RESULT PR <url>`. */
function recoveredPr(lines: string[], branch: string): string | null {
  const pushed = lines.findIndex(line => line.trim().replace(/^remote:\s*/, '').startsWith(`Create a pull request for '${branch}'`));
  const abort = lines.findIndex((line, i) => i > pushed && pushed >= 0 && /^(?:RESULT )?ABORT\b/.test(line));
  for (let i = lines.length - 1; abort >= 0 && i > abort; i--) {
    const pr = /^RESULT PR (\S+)\s*$/.exec(lines[i]!);
    if (pr) return pr[1]!;
  }
  return null;
}

/** Scan `<runsDir>/*.publish` for a confirmed push followed by an abort. Sorted by job. Read-only. */
export async function readStrandedBranches(runsDir: string, opts: { sinceHours?: number | null; now?: number } = {}): Promise<StrandedBranchesReport> {
  const now = opts.now ?? Date.now(), sinceHours = opts.sinceHours ?? null;
  const branches: StrandedBranch[] = [], recovered: RecoveredBranch[] = [], unreadable: string[] = [];
  for (const name of (await readdir(runsDir)).sort()) {
    if (!PUBLISH_LOG_NAME.test(name) || name.includes('..')) continue;
    const job = name.slice(0, -'.publish'.length), branch = `codex-bridge/${job}`;
    try {
      const lines = await readPublishLogLines(runsDir, name), abort = findPublishAbort(lines, branch);
      if (abort) {
        const mtime = (await stat(join(runsDir, name))).mtimeMs, ageHours = Math.max(0, Math.round((now - mtime) / 360000) / 10);
        if (sinceHours !== null && ageHours > sinceHours) continue;
        branches.push({
          job, branch, shape: abort.line.startsWith('RESULT ') ? 'result-abort' : 'bare-abort', reason: abort.reason || 'unknown',
          repo: repoOf(lines, abort.pushed), ageHours, filesChanged: filesOf(lines), next: nextStep(branch), recover: recoverCommand(branch),
        });
      } else { const pr = recoveredPr(lines, branch); if (pr) recovered.push({ job, branch, pr }); }
    } catch { unreadable.push(job); }
  }
  return { schema: 'jobs.stranded.v1', sinceHours, readOnly: true, status: unreadable.length ? 'unknown' : 'ok', branches, recovered, unreadable };
}
