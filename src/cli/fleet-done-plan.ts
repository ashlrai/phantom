import { statSync } from 'node:fs';

import { planDoneContract } from '../core/done-contract-plan.js';

export const FLEET_DONE_PLAN_SCHEMA = 'fleet.done-plan.v1';

const USAGE = `Usage: ashlr fleet done-plan --worktree <path> [--contract <file>] [--json]
Preview a retained job's frozen done-contract (acceptance and intended checks). Read-only: starts no process and writes nothing.
Contract precedence: --contract > DONE_CONTRACT.json > BRIDGE_NOTES.md embed; none means legacy notes mode.
Exits 1 for a claimed but invalid contract, 2 for bad arguments or worktree.`;

function parse(args: string[]): { worktree: string; contract?: string; json: boolean } | null {
  let worktree: string | undefined;
  let contract: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--worktree' && worktree === undefined && args[i + 1] !== undefined) worktree = args[++i];
    else if (arg === '--contract' && contract === undefined && args[i + 1] !== undefined) contract = args[++i];
    else return null;
  }
  return worktree === undefined ? null : { worktree, contract, json };
}

/** Read-only preview; the exit code is 0 (contract or legacy), 1 (invalid contract) or 2 (usage). */
export async function cmdFleetDonePlan(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parse(args);
  const emit = (body: Record<string, unknown>, text: string[], json: boolean) =>
    console.log(json ? JSON.stringify({ schema: FLEET_DONE_PLAN_SCHEMA, readOnly: true, ...body }) : text.join('\n'));
  const json = parsed?.json ?? args.includes('--json');
  if (!parsed) {
    if (json) emit({ status: 'invalid', error: 'usage' }, [], true);
    else console.error(USAGE);
    return 2;
  }
  let isDir = false;
  try { isDir = statSync(parsed.worktree).isDirectory(); } catch { /* categorized below */ }
  if (!isDir) {
    emit({ status: 'invalid', error: 'worktree-invalid' }, ['Worktree is not a directory.'], json);
    return 2;
  }
  let result;
  try {
    result = planDoneContract(parsed.worktree, { contractPath: parsed.contract });
  } catch {
    emit({ status: 'invalid', error: 'unreadable' }, ['Worktree is unreadable.'], json);
    return 2;
  }
  const { load, plan } = result;
  if (load.error || !plan) {
    emit({ status: 'invalid', source: load.source, error: load.error }, [`Invalid done-contract (${load.source}): ${load.error}`], json);
    return 1;
  }
  const lines = [`done-plan ${plan.mode} (${plan.source})`];
  if (plan.mode === 'legacy-notes') lines.push(`notes ${plan.legacyNotesPresent ? 'present' : 'missing or empty'}`);
  for (const c of plan.checks) lines.push(`check ${c.id} [${c.from}] ${c.required ? 'required' : 'optional'} ${c.argv ? c.argv.join(' ') : 'UNRESOLVED'}`);
  for (const a of plan.acceptance) lines.push(`accept ${a.id} ${a.required ? 'required' : 'optional'} ${a.evidence}`);
  emit({ status: plan.mode, ...plan }, lines, json);
  return 0;
}
