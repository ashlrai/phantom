import { isAbsolute } from 'node:path';
import { runContextWorker, type ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = 'Usage: ashlr fleet context-run --snapshot <absolute JSON path> --prompt <absolute text path> [--bus-address <address>] [--bus-after <cursor>] [--cwd <absolute directory>] [--timeout-ms <1..3600000>] -- <program> [args...]';
export async function cmdFleetContextRun(args: string[], io: ContextWorkerIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nExplicit worker launch; retained context is untrusted data.\n`); return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--bus-address', '--bus-after', '--cwd', '--timeout-ms'].includes(key) || flags.has(key) ||
        value === undefined || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), after = flags.get('--bus-after');
  const timeout = flags.get('--timeout-ms'), cwd = flags.get('--cwd');
  if (!snapshot || !prompt || !isAbsolute(snapshot) || !isAbsolute(prompt) || (cwd !== undefined && !isAbsolute(cwd)) ||
      (after !== undefined && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) ||
      (timeout !== undefined && (!/^\d+$/.test(timeout) || !Number.isSafeInteger(Number(timeout)) || Number(timeout) < 1 || Number(timeout) > 3600000))) return invalid();
  return runContextWorker({ snapshot, prompt, argv: args.slice(split + 1), cwd,
    busAddress: flags.get('--bus-address'), busAfter: after === undefined ? undefined : Number(after),
    timeoutMs: timeout === undefined ? undefined : Number(timeout) }, io);
}
