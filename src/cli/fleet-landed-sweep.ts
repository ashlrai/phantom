/**
 * `ashlr fleet landed-sweep` — one in-process pass of `fleet dirty-landed`
 * feeding `fleet landed-close`, so DIRTY bridge PRs whose work already landed
 * get closed without a person piping one verb into the other. It is the last
 * step of `fleet self-tick`.
 *
 * Nothing new writes here: dirty-landed's report text goes straight into
 * landed-close through its stdin seam, so landed-close's own guards (bridge
 * title, SHA, OPEN-at-head re-read, ledger-before-continue) stay the only
 * write path. Without --apply landed-close plans and closes nothing.
 */
import { sanitizePublicJson } from '../core/util/public-json.js';
import { gitOnlyLanded, type BranchEvidence } from '../core/fleet/landed-git-only.js';
import { isAbsolute } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { landedReposFromEnv, readLandedFromGit, type LandedFromGit } from '../core/fleet/landed-from-git.js';
import { cmdFleetDirtyLanded } from './fleet-dirty-landed.js';
import { MAX_LIMIT, cmdFleetLandedClose, type LandedCloseRunner } from './fleet-landed-close.js';

const USAGE = 'Usage: ashlr fleet landed-sweep [--json] [--apply] [--runs-dir <abs>] [--limit N]';
const DEFAULT_LIMIT = 5;

export interface FleetLandedSweepDeps {
  /** gh reader for the dirty-landed inspection. */
  gh?: CloudGh;
  /** Remote the inspection fetches from (tests inject a local repo). */
  remote?: string;
  /** gh runner for landed-close's re-read and close. */
  runner?: LandedCloseRunner;
  /** git-only landed reader used when the gh report is missing (tests inject). */
  landedFromGit?: (nowMs: number) => LandedFromGit;
  branchEvidence?: (refresh: boolean) => Promise<BranchEvidence>;
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

interface SweepResult {
  v: 1; inspected: number; landed: number; planned: number;
  closed: number; skipped: number; failed: number; error?: string;
  /** Plain reason the sweep did nothing because its input was not there (exit 0). */
  skippedReason?: string;
  /** Where inspected/landed came from when gh could not answer. */
  source?: 'git';
  branchEvidence?: BranchEvidence;
}

const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export async function cmdFleetLandedSweep(args: string[], deps: FleetLandedSweepDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  if (args.includes('--help') || args.includes('-h')) { output(USAGE); return 0; }
  let json = false, apply = false, runsDir: string | undefined, limit = DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) { error(`Invalid arguments. ${USAGE}`); return 2; }
      runsDir = value;
    } else if (arg === '--limit') {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) { error(`Invalid arguments. ${USAGE}`); return 2; }
      limit = Math.min(Number(value), MAX_LIMIT);
    } else { error(`Invalid arguments. ${USAGE}`); return 2; }
  }

  const result: SweepResult = { v: 1, inspected: 0, landed: 0, planned: 0, closed: 0, skipped: 0, failed: 0 };
  const finish = (code: number, message?: string): number => {
    if (message !== undefined) result.error = message;
    if (json) output(JSON.stringify(result));
    else if (result.skippedReason !== undefined) output(`landed-sweep: skipped, ${result.skippedReason}`);
    else {
      output(`landed-sweep: inspected=${result.inspected} landed=${result.landed} planned=${result.planned} ` +
        `closed=${result.closed} skipped=${result.skipped} failed=${result.failed}${message ? ` error=${message}` : ''}`);
    }
    return code;
  };

  let reportText = '';
  let inputGap: string | undefined;
  const inspectCode = await cmdFleetDirtyLanded(['--json'], {
    ...(deps.gh === undefined ? {} : { gh: deps.gh }),
    ...(deps.remote === undefined ? {} : { remote: deps.remote }),
    ...(deps.now === undefined ? {} : { now: () => new Date(deps.now!()) }),
    output: text => { reportText = text; },
    onFailure: (kind, message) => { if (kind === 'unavailable') inputGap = message; },
  });
  // The report is built here from `gh pr list`. When gh cannot answer (not installed, signed out,
  // offline) there is nothing to sweep: say so and let the tick go on. Bad data still fails.
  if (inputGap !== undefined) {
    // gh is out: plain git still says which jobs reached the default branch in the last 24 h.
    const git = (deps.landedFromGit ?? (nowMs => readLandedFromGit({ now: nowMs, repos: landedReposFromEnv() })))((deps.now ?? Date.now)());
    result.source = 'git';
    try { result.branchEvidence = sanitizePublicJson(await (deps.branchEvidence ?? (refresh => gitOnlyLanded({ fetch: refresh })))(apply)) as BranchEvidence; }
    catch { result.branchEvidence = { state: 'unknown', reason: 'branch evidence unavailable' }; }
    if (git.ok) {
      const here = git.jobs.filter(j => j.repo === git.repo).length;
      result.inspected = result.landed = here;
      result.skippedReason = `gh pr list could not be read (${inputGap}); from git, ${here} jobs landed on ${git.repo} in the last ${git.sinceHours} h. No PRs closed`;
    } else {
      result.skippedReason = `no landed report yet: gh pr list could not be read (${inputGap}) and ${git.reason ?? 'git could not be read'}`;
    }
    return finish(0);
  }
  const report = inspectCode === 0 ? parseJson(reportText) : null;
  if (report === null) return finish(1, 'dirty-landed report unreadable: gh pr list output was not a valid report');
  result.inspected = Array.isArray(report['prs']) ? report['prs'].length : 0;
  const counts = report['counts'];
  result.landed = typeof counts === 'object' && counts !== null ? num((counts as Record<string, unknown>)['landed']) : 0;

  let closeText = '';
  const closeCode = await cmdFleetLandedClose(
    ['--json', '--limit', String(limit), ...(apply ? ['--apply'] : [])],
    {
      stdin: async () => reportText,
      output: text => { closeText = text; },
      ...(runsDir === undefined ? {} : { runsDir }),
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    },
  );
  const closed = parseJson(closeText);
  if (closed === null) return finish(1, 'landed-close report unreadable');
  result.planned = num(closed['planned']);
  result.closed = num(closed['closed']);
  result.skipped = num(closed['skipped']);
  result.failed = num(closed['failed']);
  const message = typeof closed['error'] === 'string' ? closed['error'] : undefined;
  return finish(closeCode !== 0 || result.failed > 0 ? 1 : 0, message);
}
