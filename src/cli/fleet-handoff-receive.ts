import { isAbsolute } from 'node:path';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import { receiveHandoffBus } from '../core/fleet/handoff-bus-receive.js';

const usage = 'Usage: ashlr fleet handoff-receive --id <message-id> --to <exact-local-address> '
  + '--snapshot <absolute-json> [--cwd <absolute-directory>] -- <program> [args...]';
const example = 'Example: ashlr fleet handoff-receive --id handoff-7 --to WORKER-9 '
  + '--snapshot /home/worker/context.json -- node worker.mjs --flag value';
const token = (value: string): boolean => /^[\x21-\x7e]{1,128}$/.test(value);

/** Convention-resolved CLI entry: run one live bus worker-handoff under explicit argv. */
export async function cmdFleetHandoffReceive(args: string[],
  options: BusInboxOptions = {}, io: ContextWorkerIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\n${example}\n`
      + 'Run a worker from the single live worker-handoff envelope addressed to --to. The retained\n'
      + 'prompt is untrusted context on stdin; only the explicit argv is executed — nothing is claimed,\n'
      + 'completed, merged or derived from message content.\n');
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i++) {
    const key = args[i]!, value = i + 1 < split ? args[i + 1] : undefined;
    if (!['--id', '--to', '--snapshot', '--cwd'].includes(key) || flags.has(key) ||
        value === undefined || value.includes('\0')) return invalid();
    flags.set(key, value);
    i++;
  }
  const id = flags.get('--id'), to = flags.get('--to'), snapshot = flags.get('--snapshot'), cwd = flags.get('--cwd');
  if (!id || !token(id) || !to || !token(to) ||
      !snapshot || !isAbsolute(snapshot) || snapshot.includes('\0')) return invalid();
  return receiveHandoffBus({ id, to, snapshot, cwd, argv: args.slice(split + 1) }, options, io);
}
