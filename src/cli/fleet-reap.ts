import { planWorktreeReap, WORKTREE_REAP_CAP, type WorktreeReapPlan } from '../core/fleet/worktree-reap-tick.js';
import { formatBytes, readWorktrees, WORKTREE_REASONS, type WorktreesDeps } from '../core/fleet/worktrees.js';

const usage = 'Usage: phm fleet reap [--plan | --apply] [--json]';
const HELP = `${usage}
Show which finished job worktrees the reap would remove next (up to ${WORKTREE_REAP_CAP}) and why every
worktree is or is not safe: empty, merged, closed, kept, dirty-no-result, too-new.
  --plan    Print the plan and remove nothing (the default).
  --apply   Remove up to ${WORKTREE_REAP_CAP} safe worktrees with git worktree remove (never --force).`;

export const breakdownLine = (reasons: WorktreeReapPlan['reasons']): string =>
  WORKTREE_REASONS.filter(reason => reasons[reason]).map(reason => `${reasons[reason]} ${reason}`).join(', ') || 'none';

/** Thin handler: parse argv, delegate to src/core/fleet/worktrees.ts. */
export async function cmdFleetReap(args: string[], deps: WorktreesDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  const json = args.includes('--json');
  const apply = args.includes('--apply');
  if (new Set(args).size !== args.length || args.some(a => !['--plan', '--apply', '--json'].includes(a)) || (apply && args.includes('--plan'))) {
    console.error(usage); return 2;
  }
  try {
    if (apply) {
      const report = await readWorktrees('apply', { ...deps, maxRemovals: WORKTREE_REAP_CAP });
      const removed = (report.removals ?? []).filter(r => r.status === 'removed').length;
      if (json) console.log(JSON.stringify({ schema: 'fleet.reap-apply.v1', removed, removals: report.removals ?? [], reasons: report.reasons }));
      else console.log(`Removed ${removed} of ${(report.removals ?? []).length} attempted. All worktrees: ${breakdownLine(report.reasons)}.`);
      return (report.removals ?? []).every(r => r.status === 'removed') ? 0 : 1;
    }
    const plan = await planWorktreeReap(deps);
    if (json) console.log(JSON.stringify(plan));
    else {
      for (const c of plan.candidates) console.log(`${c.job}\t${c.reason}\t${c.bytes === null ? '-' : formatBytes(c.bytes)}`);
      console.log(`${plan.total} job worktrees: ${breakdownLine(plan.reasons)}.`);
      console.log(`Would remove ${plan.candidates.length} now (cap ${plan.cap})${plan.waiting ? `, ${plan.waiting} more waiting` : ''}. Nothing was removed.`);
    }
    return 0;
  } catch { console.error('Cannot read worktrees.'); return 1; }
}
