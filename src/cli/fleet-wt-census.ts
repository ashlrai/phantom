/**
 * `phm fleet wt-census` — the full worktree census, SAFE-REAP/HOLD/UNKNOWN.
 *
 * Every worktree under the job root (~/Projects/ashlrai/wt, the loadgate's
 * `worktrees` count) and the runs root (~/.ashlr-runs/wt) is classified from
 * `phm fleet wt-audit`'s evidence chain plus a bounded git pass — owning
 * repo, last-commit date and an uncommitted-work verdict for candidates —
 * into:
 *
 *   safe-reap   merged, published or empty, provably clean, not protected —
 *               the reap plan's headline, with a top-N largest-candidate list.
 *   hold        running, in-flight, held, archived, open/ended, recorded,
 *               finished-but-unpublished, dirty or protect-listed.
 *   unknown     insufficient evidence; never counts as safe.
 *
 * Roll-ups group worktrees by census class, audit state, repo and age
 * bucket. READ-ONLY: no --apply exists; the `via` field names the
 * sanctioned reaper (reap-one.sh or git worktree remove as used by
 * `fleet worktree-stale --apply` / `fleet wt-reap --apply`).
 */
import { isAbsolute } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  formatWtCensus, readWtCensus, type WtCensusDeps,
} from '../core/fleet/wt-census.js';

const usage = 'Usage: phm fleet wt-census [--no-size] [--no-git] [--wt-dir <abs>] [--runs-dir <abs>] [--top <n>] [--json]';

const HELP = `${usage}
Census every fleet worktree into safe-reap / hold / unknown, with repo,
last-commit date, size and age-bucket roll-ups and the top safe-reap
candidates by bytes. Read-only: deletes nothing, publishes nothing.
--no-size    skip the size walk; classes still reported, bytes null.
--no-git     skip git subprocess probes; safe-reap candidates stay unknown.
--wt-dir     job worktree root (default $ASHLR_WT_DIR or ~/Projects/ashlrai/wt).
--runs-dir   runs root (default $ASHLR_RUNS_DIR or ~/.ashlr-runs);
             its wt/ child is censused as the second root.
--top <n>    safe-reap candidate list size (default 20, max 100).
Exit 0 normally, 1 when a worktree root cannot be listed, 2 bad usage.`;

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetWtCensusDeps extends WtCensusDeps { output?: Output }

export async function cmdFleetWtCensus(args: string[], deps: FleetWtCensusDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output.log(HELP);
    return 0;
  }
  let json = false;
  let wantSize = deps.wantSize !== false;
  let wantGit = deps.wantGit !== false;
  let wtRoot = deps.wtRoot;
  let runsRoot = deps.runsRoot;
  let top = deps.top;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--no-size') wantSize = false;
    else if (arg === '--no-git') wantGit = false;
    else if (arg === '--wt-dir' || arg === '--runs-dir') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        output.error(`error: ${arg} needs an absolute path\n${usage}`);
        return 2;
      }
      if (arg === '--wt-dir') wtRoot = value;
      else runsRoot = value;
    } else if (arg === '--top') {
      const value = args[++i];
      if (!value || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) {
        output.error(`error: --top needs an integer from 1 to 100\n${usage}`);
        return 2;
      }
      top = Number(value);
    } else {
      output.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${usage}`);
      return 2;
    }
  }
  const report = await readWtCensus({ ...deps, wtRoot, runsRoot, wantSize, wantGit, top });
  if (json) {
    output.log(JSON.stringify(sanitizePublicJson(report)));
  } else {
    for (const line of formatWtCensus(report)) output.log(line);
  }
  const degraded = report.sources.worktrees === 'degraded' || report.sources.runsWorktrees === 'degraded';
  return degraded ? 1 : 0;
}
