import { isAbsolute } from 'node:path';
import { runContextCheckedRun, type ContextCheckedRunIO } from '../core/fleet/context-checked-run.js';

const usage = 'Usage: ashlr fleet context-checked-run --snapshot <absolute JSON path> --prompt <absolute text path> [--budget-seconds <n>] -- <program> [args...]';
export async function cmdFleetContextCheckedRun(args: string[], io: ContextCheckedRunIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nExplicit worker launch, then the real local gate on this working tree; a pass is local verification only, never merge or publish authority.\n`); return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--budget-seconds'].includes(key) || flags.has(key) ||
        value === undefined || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), budget = flags.get('--budget-seconds');
  const budgetSeconds = budget === undefined ? undefined : Number(budget);
  if (!snapshot || !prompt || !isAbsolute(snapshot) || !isAbsolute(prompt) ||
      (budgetSeconds !== undefined && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0))) return invalid();
  return runContextCheckedRun({ snapshot, prompt, argv: args.slice(split + 1), budgetSeconds }, io);
}
