import { inspectWorktree, renderWorktreeReport, repairWorktree } from '../core/worktree-doctor.js';

const usage = 'Usage: phm doctor worktree [--repair] [--json]';

/** Thin handler: parse argv, delegate to src/core/worktree-doctor.ts. */
export async function cmdDoctorWorktree(args: string[], root: string = process.cwd()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (args.some(arg => arg !== '--json' && arg !== '--repair')) { console.error(usage); return 2; }
  const report = args.includes('--repair') ? repairWorktree(root) : inspectWorktree(root);
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderWorktreeReport(report));
  return report.ok ? 0 : 1;
}
