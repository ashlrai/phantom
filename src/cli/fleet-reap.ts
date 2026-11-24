import { WORKTREE_REAP_CAP } from '../core/fleet/worktree-reap-tick.js';
import { formatBytes, readWorktrees, type WorktreesDeps } from '../core/fleet/worktrees.js';

const usage = 'Usage: phm fleet reap [--plan] [--json]';

export async function cmdFleetReap(args: string[], deps: WorktreesDeps = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nShow a bounded, read-only plan of safe worktrees and their holds.`);
    return 0;
  }
  if (new Set(args).size !== args.length || args.some(arg => !['--plan', '--json'].includes(arg))) {
    console.error(usage);
    return 2;
  }
  try {
    const report = await readWorktrees('dry-run', deps);
    const safe = report.rows.filter(row => row.safe);
    const held: Record<string, number> = {};
    const states: Record<string, number> = {};
    for (const row of report.rows) {
      states[row.state] = (states[row.state] ?? 0) + 1;
      if (!row.safe) {
        const reason = row.hold ?? 'unknown';
        held[reason] = (held[reason] ?? 0) + 1;
      }
    }
    const plan = {
      schema: 'fleet.reap-plan.v1', total: report.rows.length, cap: WORKTREE_REAP_CAP,
      sourcesOk: report.sourcesOk, candidates: safe.slice(0, WORKTREE_REAP_CAP),
      waiting: Math.max(0, safe.length - WORKTREE_REAP_CAP), states, held,
    };
    if (args.includes('--json')) console.log(JSON.stringify(plan));
    else {
      for (const row of plan.candidates) console.log(`${row.job}\t${row.state}\t${row.bytes === null ? 'unknown' : formatBytes(row.bytes)}`);
      console.log(`${plan.candidates.length} candidates of ${safe.length} safe worktrees (cap ${plan.cap}); ${plan.waiting} waiting. ${plan.total} total.`);
      console.log(`Held: ${Object.entries(held).map(([reason, count]) => `${reason}: ${count}`).join(', ') || 'none'}. Nothing was removed.`);
    }
    return 0;
  } catch {
    console.error('Cannot read worktrees.');
    return 1;
  }
}
