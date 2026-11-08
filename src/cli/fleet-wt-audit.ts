/**
 * `phm fleet wt-audit` — per-worktree audit of ~/Projects/ashlrai/wt.
 *
 * Every direct subdirectory is classified from the same evidence dispatchd
 * and reap-one.sh act on — .dispatched/.reaping/.rc/.pid markers, the .base
 * and .publish sidecars, queue/keep.txt and status.json, the jobs ledger,
 * the process table and kept-worktrees.json pins — into one state per
 * worktree plus a measured size.
 *
 * `--reap-plan` keeps only worktrees provably safe for sanctioned reaping:
 * never running, never in-flight, never held. `via` names the sanctioned
 * tool — 'reap-one' hands the job to ~/.ashlr-runs/bin/reap-one.sh,
 * 'worktree-remove' is the plain `git worktree remove` that
 * `fleet worktree-stale --apply` and `fleet wt-reap --apply` already run.
 *
 * READ-ONLY: the audit deletes nothing, publishes nothing and touches no
 * queue state. All readers are injectable for hermetic tests.
 */
import { isAbsolute } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  formatWtAudit, formatWtReapPlan, readWtAudit,
  type ReadWtAuditOptions,
} from '../core/fleet/wt-audit.js';

const usage = 'Usage: phm fleet wt-audit [--reap-plan] [--no-size] [--wt-dir <abs>] [--runs-dir <abs>] [--json]';

const HELP = `${usage}
Audit every job worktree under ~/Projects/ashlrai/wt: lifecycle state
(running, reaping, publishing, held, archived, merged, published, empty,
finished, recorded, orphaned, unknown), pool, size and per-worktree
blockers, from the same markers dispatchd and reap-one.sh use.
Read-only: deletes nothing, publishes nothing.
--reap-plan  emit only worktrees eligible for sanctioned reaping:
             'reap-one' (reap-one.sh <job>) or 'worktree-remove'
             (git worktree remove, as in worktree-stale/wt-reap --apply).
--no-size    skip the size walk; states still reported, bytes null.
--wt-dir     worktree root (default $ASHLR_WT_DIR or ~/Projects/ashlrai/wt).
--runs-dir   runs root (default $ASHLR_RUNS_DIR or ~/.ashlr-runs).
Exit 0 normally, 1 when the worktree root cannot be listed, 2 bad usage.`;

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetWtAuditDeps extends ReadWtAuditOptions { output?: Output }

export async function cmdFleetWtAudit(args: string[], deps: FleetWtAuditDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output.log(HELP);
    return 0;
  }
  let json = false;
  let wantPlan = false;
  let wantSize = deps.wantSize !== false;
  let wtRoot = deps.wtRoot;
  let runsRoot = deps.runsRoot;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--reap-plan') wantPlan = true;
    else if (arg === '--no-size') wantSize = false;
    else if (arg === '--wt-dir' || arg === '--runs-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        output.error(`error: ${arg} needs an absolute path\n${usage}`);
        return 2;
      }
      if (arg === '--wt-dir') wtRoot = value;
      else runsRoot = value;
    } else {
      output.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${usage}`);
      return 2;
    }
  }
  const report = await readWtAudit({ ...deps, wtRoot, runsRoot, wantSize, wantPlan });
  if (json) {
    output.log(JSON.stringify(sanitizePublicJson(report)));
  } else {
    for (const line of (wantPlan ? formatWtReapPlan(report) : formatWtAudit(report))) output.log(line);
  }
  return report.sources.worktrees === 'degraded' ? 1 : 0;
}
