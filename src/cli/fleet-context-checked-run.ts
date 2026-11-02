import { isAbsolute } from 'node:path';
import { runContextCheckedRun, type ContextCheckedRunIO } from '../core/fleet/context-checked-run.js';

const usage = 'Usage: ashlr fleet context-checked-run --snapshot <absolute JSON path> --prompt <absolute text path> [--timeout-ms <1..3600000>] [--budget-seconds <n>] -- <program> [args...]';
export async function cmdFleetContextCheckedRun(args: string[], io: ContextCheckedRunIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\n--timeout-ms limits the worker; --budget-seconds limits the local gate.\nExplicit worker launch, then the real local gate on this working tree; a pass is local verification only, never merge or publish authority.\n`); return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--budget-seconds', '--timeout-ms'].includes(key) || flags.has(key) ||
        value === undefined || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), budget = flags.get('--budget-seconds');
  const budgetSeconds = budget === undefined ? undefined : Number(budget);
  const timeout = flags.get('--timeout-ms');
  const timeoutMs = timeout === undefined ? undefined : Number(timeout);
  if (!snapshot || !prompt || !isAbsolute(snapshot) || !isAbsolute(prompt) ||
      (timeout !== undefined && (!/^\d+$/.test(timeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs! < 1 || timeoutMs! > 3600000)) ||
      (budgetSeconds !== undefined && (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0))) return invalid();
  return runContextCheckedRun({ snapshot, prompt, argv: args.slice(split + 1), budgetSeconds, timeoutMs }, io);
}
