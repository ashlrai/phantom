import { changeHandoff, checkNames, verifyChange, type CheckName } from '../core/verify-change.js';
import { doneContractHandoff, doneContractPlan, evaluateDoneContract, type DoneContractVerdict } from '../core/done-contract.js';

export async function cmdVerify(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  if (args[0] === 'change') return verifyChangeCmd(args.slice(1));
  if (args[0] === 'done') return verifyDoneCmd(args.slice(1));
  return usage();
}

function verifyChangeCmd(args: string[]): number {
  let worktree: string | undefined;
  let checks: CheckName[] | undefined;
  for (let i = 0; i < args.length; i++) {
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

function verifyDoneCmd(args: string[]): number {
  let worktree: string | undefined;
  let contract: string | undefined;
  let plan = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--plan') { if (plan) return usage(); plan = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    if (flag === '--worktree' && !worktree) worktree = value;
    else if (flag === '--contract' && !contract) contract = value;
    else return usage();
  }
  if (!worktree) return usage();
  const opts = contract ? { contractPath: contract } : {};
  try {
    if (plan) {
      const planResult = doneContractPlan(worktree, opts);
      console.log(JSON.stringify(planResult));
      console.error(planResult.mode === 'notes'
        ? 'Done contract plan: no contract found — legacy notes-file expectation applies.'
        : `Done contract plan: ${planResult.commands.length} command(s), ${planResult.acceptance.length} acceptance item(s)${planResult.error ? ` — error: ${planResult.error}` : ''}`);
      return planResult.error ? 1 : 0;
    }
    const verdict = evaluateDoneContract(worktree, opts);
    console.log(JSON.stringify(verdict));
    console.error(doneContractHandoff(verdict));
    return verdict.pass ? 0 : 1;
  } catch {
    const verdict: DoneContractVerdict = { pass: false, mode: 'contract', job: null, source: 'none', notes_file: null, notes_present: false, checks: [], acceptance: [], error: 'Cannot inspect worktree' };
    console.log(JSON.stringify(verdict));
    console.error(doneContractHandoff(verdict));
    return 1;
  }
}

const USAGE = 'Usage: phantom verify change --worktree <path> [--checks typecheck,unit,lint,secrets]\n       phantom verify done --worktree <path> [--contract <path>] [--plan]';
function usage(): number {
  console.error(USAGE);
  return 2;
}
