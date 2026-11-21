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
import { isAbsolute } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { gitOnlyLanded, type GhFailure } from '../core/fleet/landed-git-only.js';
import type { GitRunner } from '../core/verse/git-ops.js';
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
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Clone the git-only path reads (default: the working directory). */
  repoDir?: string;
  /** git runner for the git-only path (tests inject one). */
  git?: GitRunner;
}

interface SweepResult {
  v: 1; inspected: number; landed: number; planned: number;
  closed: number; skipped: number; failed: number; error?: string;
  /** ok = swept; skipped = a tool is missing, nothing to do; failed = a read broke. */
  state: 'ok' | 'skipped' | 'failed';
  /** Which path decided "landed": gh PR list, or local git branches. */
  mode: 'gh' | 'git-only';
  /** Why the step is skipped, failed, or fell back to git. */
  reason?: string;
  /** git-only: local/remote branches fully reachable from origin/master. */
  landedBranches?: string[];
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

  const result: SweepResult = { v: 1, state: 'ok', mode: 'gh', inspected: 0, landed: 0, planned: 0, closed: 0, skipped: 0, failed: 0 };
  const finish = (code: number, message?: string): number => {
    if (message !== undefined) { result.error = message; result.reason ??= message; }
    if (code !== 0) result.state = 'failed';
    if (json) output(JSON.stringify(result));
    else {
      output(`landed-sweep: inspected=${result.inspected} landed=${result.landed} planned=${result.planned} ` +
        `closed=${result.closed} skipped=${result.skipped} failed=${result.failed}${result.mode === 'git-only' ? ` mode=git-only landed-branches=${result.landedBranches?.length ?? 0}` : ''}` +
        `${result.state === 'skipped' ? ` skipped: ${result.reason}` : message ? ` error=${message}` : result.reason ? ` note=${result.reason}` : ''}`);
    }
    return code;
  };

  let reportText = '';
  let ghFailure: GhFailure | undefined;
  const inspectCode = await cmdFleetDirtyLanded(['--json'], {
    ...(deps.gh === undefined ? {} : { gh: deps.gh }),
    ...(deps.remote === undefined ? {} : { remote: deps.remote }),
    ...(deps.now === undefined ? {} : { now: () => new Date(deps.now!()) }),
    output: text => { reportText = text; },
    onGhFailure: failure => { ghFailure = failure; },
  });
  const report = inspectCode === 0 ? parseJson(reportText) : null;
  if (report === null && ghFailure !== undefined && ghFailure.kind !== 'error') {
    // gh is missing, signed out or offline: decide "landed" from the local clone instead.
    // Closing a PR needs gh, so this path reports and closes nothing.
    result.mode = 'git-only';
    const local = await gitOnlyLanded({ ...(deps.repoDir === undefined ? {} : { repoDir: deps.repoDir }), ...(deps.git === undefined ? {} : { git: deps.git }) });
    if (local.state === 'skipped') { result.state = 'skipped'; result.reason = `${ghFailure.reason}; ${local.reason}`; return finish(0); }
    if (local.state === 'failed') return finish(1, `${ghFailure.reason}; ${local.reason}`);
    result.inspected = local.branches.length;
    result.landedBranches = local.branches.filter(branch => branch.landed).map(branch => branch.name);
    result.landed = result.landedBranches.length;
    result.reason = `${ghFailure.reason}; used git`;
    return finish(0);
  }
  if (report === null) return finish(1, ghFailure?.reason ?? 'dirty-landed report unreadable');
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
