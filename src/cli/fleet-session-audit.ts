/**
 * `phm fleet session-audit` — per-lane session-state inventory.
 *
 * Reports how many CLI sessions each lane home holds (devin task records,
 * codex rollouts, claude transcripts, grok session dirs), their ages and
 * measured sizes. `--prune-plan` lists only sessions older than
 * `--older-than-days` (default 30) whose results provably published: a devin
 * task in a terminal state with a recorded pr/report, or a CLI session whose
 * job worktree's ledger attempt finished MERGED / RESULT PR / RESULT EMPTY.
 * Auth files, config, sqlite state and sessions with no published outcome are
 * never candidates — unknown never counts as safe.
 *
 * READ-ONLY: the audit deletes nothing, publishes nothing and touches no
 * queue state. All readers are injectable for hermetic tests.
 */
import { isAbsolute } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  formatSessionAudit, formatSessionPrunePlan, readSessionAudit,
  SESSION_AUDIT_DEFAULT_OLDER_THAN_DAYS, type SessionAuditDeps,
} from '../core/fleet/session-audit.js';

const usage =
  'Usage: phm fleet session-audit [--prune-plan] [--older-than-days <n>] ' +
  '[--home <abs>] [--ashlr-dir <abs>] [--runs-dir <abs>] [--wt-dir <abs>] [--no-size] [--json]';

const HELP = `${usage}
Audit agent-CLI session state under every lane home: ~/.ashlr/devin (devin
task records), $CODEX_HOME / $CODEX_HOME_ALT (~/.codex, ~/.codex-2),
$CLAUDE_CONFIG_DIR (~/.claude) and each ~/.ashlr/native-profiles/<name>
seat's native-state (codex rollouts, claude transcripts, grok session dirs).
Read-only: deletes nothing, publishes nothing.
--prune-plan       list only sessions >= --older-than-days old with published
                   results — the local file is never the last copy.
--older-than-days  age gate for the prune plan (default ${SESSION_AUDIT_DEFAULT_OLDER_THAN_DAYS}).
--no-size          skip grok session-dir size walks; bytes stay null there.
--home             home root (default the OS home).
--ashlr-dir        ashlr state root (default $ASHLR_HOME or ~/.ashlr).
--runs-dir         runs root (default $ASHLR_RUNS_DIR or ~/.ashlr-runs).
--wt-dir           job worktree root (default $ASHLR_WT_DIR or
                   ~/Projects/ashlrai/wt).
Exit 0 normally, 1 when the native-profiles root cannot be listed, 2 bad usage.`;

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetSessionAuditDeps extends SessionAuditDeps { output?: Output }

export async function cmdFleetSessionAudit(args: string[], deps: FleetSessionAuditDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output.log(HELP);
    return 0;
  }
  let json = false;
  let wantPlan = false;
  let wantSize = deps.wantSize !== false;
  let olderThanDays = deps.olderThanDays;
  const roots = { ...deps.roots };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--prune-plan') wantPlan = true;
    else if (arg === '--no-size') wantSize = false;
    else if (arg === '--older-than-days') {
      const value = args[++i];
      if (!value || !/^(?:\d+\.?\d*|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
        output.error(`error: --older-than-days needs a positive number\n${usage}`);
        return 2;
      }
      olderThanDays = Math.min(Number(value), 3650);
    } else if (['--home', '--ashlr-dir', '--runs-dir', '--wt-dir'].includes(arg)) {
      const value = args[++i];
      if (!value || !isAbsolute(value)) {
        output.error(`error: ${arg} needs an absolute path\n${usage}`);
        return 2;
      }
      if (arg === '--home') roots.home = value;
      else if (arg === '--ashlr-dir') roots.ashlrDir = value;
      else if (arg === '--runs-dir') roots.runsDir = value;
      else roots.wtDir = value;
    } else {
      output.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${usage}`);
      return 2;
    }
  }
  const report = await readSessionAudit({ ...deps, roots, wantSize, olderThanDays, wantPlan });
  if (json) {
    output.log(JSON.stringify(sanitizePublicJson(report)));
  } else {
    for (const line of (wantPlan ? formatSessionPrunePlan(report) : formatSessionAudit(report))) output.log(line);
  }
  return report.sources.profiles === 'degraded' ? 1 : 0;
}
