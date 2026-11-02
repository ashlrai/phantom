import { isAbsolute } from 'node:path';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import { replyHandoffBus } from '../core/fleet/handoff-bus-reply.js';

const usage = 'Usage: ashlr fleet handoff-reply --id <message-id> --to <exact-recipient> '
  + '--snapshot <absolute-json> --reply-id <distinct-id> --spool-dir <absolute-private-dir> '
  + '--timeout-ms <1..3600000> -- <program> [args...]';
const example = 'Example: ashlr fleet handoff-reply --id handoff-7 --to WORKER-9 '
  + '--snapshot /home/worker/context.json --reply-id handoff-7-exit '
  + '--spool-dir /home/worker/replies --timeout-ms 600000 -- node worker.mjs --flag value';
const token = (value: string): boolean => /^[\x21-\x7e]{1,128}$/.test(value);

/** Convention-resolved CLI entry: run one live bus worker-handoff under
 * explicit argv and durably publish its worker-exit reply on the same bus. */
export async function cmdFleetHandoffReply(args: string[],
  options: BusInboxOptions = {}, io: ContextWorkerIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\n${example}\n`
      + 'Like handoff-receive, plus a correlated worker-exit reply: the retained prompt is untrusted\n'
      + 'context on stdin and only the explicit argv executes — nothing is claimed, completed, merged\n'
      + 'or derived from message content. The reply routes the handoff recipient back to its sender.\n'
      + 'A failed publication is durably spooled for context-deliver/context-drain retry without\n'
      + 'rerunning the worker.\n');
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--id', '--to', '--snapshot', '--reply-id', '--spool-dir', '--timeout-ms'].includes(key) ||
        flags.has(key) || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const id = flags.get('--id'), to = flags.get('--to'), snapshot = flags.get('--snapshot');
  const replyId = flags.get('--reply-id'), spoolDir = flags.get('--spool-dir'), timeout = flags.get('--timeout-ms');
  const timeoutMs = timeout !== undefined && /^\d+(?![\s\S])/.test(timeout) ? Number(timeout) : NaN;
  if (!id || !token(id) || !to || !token(to) || !replyId || !token(replyId) ||
      !snapshot || !isAbsolute(snapshot) || !spoolDir || !isAbsolute(spoolDir) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) return invalid();
  const result = await replyHandoffBus(
    { id, to, snapshot, replyId, spoolDir, timeoutMs, argv: args.slice(split + 1) }, options, io);
  // Static statuses and numeric codes only: no routing IDs, record paths or child/context data.
  (io.stderr ?? process.stderr).write(
    `${JSON.stringify({ workerExit: result.workerExit, delivery: { status: result.delivery.status } })}\n`);
  return result.exitCode;
}
