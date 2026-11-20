import { inspectWorktree, renderWorktreeReport } from '../core/worktree-doctor.js';

const usage = 'Usage: phm doctor worktree [--json]';

/** Thin handler: parse argv, delegate to src/core/worktree-doctor.ts. */
export async function cmdDoctorWorktree(args: string[], root: string = process.cwd()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  const report = inspectWorktree(root);
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderWorktreeReport(report));
  return report.ok ? 0 : 1;
}
