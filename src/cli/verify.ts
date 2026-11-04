import { changeHandoff, checkNames, verifyChange, type CheckName } from '../core/verify-change.js';

export async function cmdVerify(args: string[]): Promise<number> {
  let worktree: string | undefined;
  let checks: CheckName[] | undefined;
  if (args[0] !== 'change') return usage();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    if (flag === '--worktree' && !worktree) worktree = value;
    else if (flag === '--checks' && !checks) {
      const names = value.split(',');
      if (!names.every((name) => checkNames.includes(name as CheckName)) || new Set(names).size !== names.length) return usage();
      checks = names as CheckName[];
    } else return usage();
  }
  if (!worktree) return usage();
  try {
    const verdict = verifyChange(worktree, checks);
    console.log(JSON.stringify(verdict));
    console.error(changeHandoff(verdict));
    return verdict.pass ? 0 : 1;
  } catch {
    const verdict = { pass: false, checks: [{ name: 'setup', ok: false, secs: 0, first_error: 'Cannot inspect worktree or toolchain configuration' }], changed_files: [] };
    console.log(JSON.stringify(verdict));
    console.error(changeHandoff(verdict));
    return 1;
  }
}
function usage(): number {
  console.error('Usage: phantom verify change --worktree <path> [--checks typecheck,unit,lint,secrets]');
  return 2;
}
