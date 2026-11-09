import { statSync } from 'node:fs';

import { doneContractHandoff, evaluateDoneContract } from '../core/done-contract-evaluate.js';

export const FLEET_DONE_EVALUATE_SCHEMA = 'fleet.done-evaluate.v1';

const USAGE = `Usage: ashlr fleet done-evaluate --worktree <path> --trust-worktree [--contract <file>] [--json]
Run a retained job's frozen done-contract checks and report actual outcomes (unlike done-plan, which only previews).
This executes the contract's commands from the worktree: pass --trust-worktree only for a worktree you trust.
Child output is never printed. Local verdict only: no publish, merge or gate change.
Exits 0 when passed, 1 when evaluation failed or the contract is invalid, 2 for bad arguments or worktree.`;

function parse(args: string[]): { worktree: string; contract?: string; json: boolean; trusted: boolean } | null {
  let worktree: string | undefined;
  let contract: string | undefined;
  let json = false;
  let trusted = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--trust-worktree') trusted = true;
    else if (arg === '--worktree' && worktree === undefined && args[i + 1] !== undefined) worktree = args[++i];
    else if (arg === '--contract' && contract === undefined && args[i + 1] !== undefined) contract = args[++i];
    else return null;
  }
  return worktree === undefined || !trusted ? null : { worktree, contract, json, trusted };
}

export async function cmdFleetDoneEvaluate(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parse(args);
  const json = parsed?.json ?? args.includes('--json');
  const emit = (body: Record<string, unknown>, text: string) =>
    console.log(json ? JSON.stringify({ schema: FLEET_DONE_EVALUATE_SCHEMA, ...body }) : text);
  if (!parsed) {
    if (json) emit({ status: 'invalid', error: 'usage' }, '');
    else console.error(USAGE);
    return 2;
  }
  let isDir = false;
  try { isDir = statSync(parsed.worktree).isDirectory(); } catch { /* categorized below */ }
  if (!isDir) {
    emit({ status: 'invalid', error: 'worktree-invalid' }, 'Worktree is not a directory.');
    return 2;
  }
  const evaluation = evaluateDoneContract(parsed.worktree, { contractPath: parsed.contract });
  const { schema: evaluationSchema, ...rest } = evaluation;
  emit({ status: evaluation.verdict, evaluationSchema, ...rest }, doneContractHandoff(evaluation));
  return evaluation.pass ? 0 : 1;
}
