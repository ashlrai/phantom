import { isAbsolute } from 'node:path';
import type { BusInboxOptions, listBusInboxAfter } from '../core/fleet/bus-inbox.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import { runThreadWorker, THREAD_RUN_MAX_BYTE_BUDGET } from '../core/fleet/thread-worker-run.js';

const usage = 'Usage: ashlr fleet thread-run --id <root message id> --snapshot <absolute JSON path> --prompt <absolute text path> --byte-budget <1..65536> -- <program> [args...]';

export interface ThreadRunIO extends ContextWorkerIO {
  /** Injectable inbox reader for tests; defaults to the durable local bus inbox. */
  list?: typeof listBusInboxAfter;
}

export async function cmdFleetThreadRun(args: string[], options: BusInboxOptions = {}, io: ThreadRunIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nExplicit worker launch; a cited retained bus thread travels as untrusted stdin data.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--id', '--snapshot', '--prompt', '--byte-budget'].includes(key) || flags.has(key) ||
        value === undefined || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const id = flags.get('--id'), snapshot = flags.get('--snapshot');
  const prompt = flags.get('--prompt'), budget = flags.get('--byte-budget');
  const parsed = budget !== undefined && /^\d+$/.test(budget) ? Number(budget) : NaN;
  if (!id || !snapshot || !prompt || !isAbsolute(snapshot) || !isAbsolute(prompt) ||
      !Number.isSafeInteger(parsed) || parsed < 1 || parsed > THREAD_RUN_MAX_BYTE_BUDGET) return invalid();
  return runThreadWorker({ id, snapshot, prompt, byteBudget: parsed, argv: args.slice(split + 1) },
    options, { stdout: io.stdout, stderr: io.stderr }, { list: io.list });
}
