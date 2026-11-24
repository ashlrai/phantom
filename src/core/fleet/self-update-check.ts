/**
 * self-update-check.ts — `phm self-update --check` and `--plan`: how far the host's running phm is behind
 * master, the last rebuild's result, and the blue/green steps that would fix it. Read-only: the check reads
 * local git refs and leader/phm-live-state.txt; the plan is text and runs nothing. The same `SelfUpdateCheck`
 * is what the Leader card can read (the `build` and `lastBuild` of doctor.build.v1 carry the same facts).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { liveStatePath } from './build-last.js';
import { readBuildLive, type BuildLiveOptions, type BuildLiveReport } from './build-live.js';

export const SELF_UPDATE_CHECK_SCHEMA = 'self-update.check.v1';

export interface SelfUpdateCheck {
  schema: typeof SELF_UPDATE_CHECK_SCHEMA;
  /** The running build's commit and when it was built (null when not known). */
  running: { sha: string | null; builtAt: string | null };
  behind: number | null;
  lastBuild: { result: 'ok' | 'failed' | 'skipped' | 'unknown'; line: string };
  state: 'current' | 'behind' | 'failed' | 'unknown';
  /** "current", "behind N commits", "last build failed: <one line>" or "unknown: <why>". */
  verdict: string;
}

export const runsDirOf = (env: NodeJS.ProcessEnv = process.env): string => env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs');

export function selfUpdateCheck(report: BuildLiveReport): SelfUpdateCheck {
  const last = report.lastBuild;
  const lastBuild = last?.state === 'known' ? { result: last.result, line: last.line } : { result: 'unknown' as const, line: last?.why ?? 'not read' };
  const behind = report.behind.state === 'known' ? report.behind.count : null;
  const running = { sha: report.commit.state === 'known' ? report.commit.sha : null, builtAt: last?.state === 'known' ? last.at : null };
  const base = { schema: SELF_UPDATE_CHECK_SCHEMA, running, behind, lastBuild } as const;
  if (lastBuild.result === 'failed') return { ...base, state: 'failed', verdict: `last build failed: ${lastBuild.line}` };
  if (behind === null) return { ...base, state: 'unknown', verdict: `unknown: ${report.behind.state === 'unknown' ? report.behind.why : 'not read'}` };
  if (behind === 0) return { ...base, state: 'current', verdict: 'current' };
  const skipped = lastBuild.result === 'skipped' ? ` (last build skipped: ${lastBuild.line})` : '';
  return { ...base, state: 'behind', verdict: `behind ${behind} ${behind === 1 ? 'commit' : 'commits'}${skipped}` };
}

export function readSelfUpdateCheck(opts: BuildLiveOptions & { runsDir?: string } = {}): SelfUpdateCheck {
  return selfUpdateCheck(readBuildLive({ liveStatePath: liveStatePath(opts.runsDir ?? runsDirOf()), ...opts }));
}

/** The blue/green steps, in plain words. Text only: nothing here runs, and none of it touches the live checkout. */
export const SELF_UPDATE_PLAN: readonly string[] = [
  'Build master into a new directory next to the live one (never inside it).',
  'Smoke check the new build there: `phm --version` and `phm doctor build` must pass.',
  'Swap the `current` symlink to the new directory in one step; the running process keeps serving until it restarts.',
  'Keep the old directory for rollback; to roll back, point `current` at it again.',
  'Delete older directories only after the new build has run cleanly.',
];
