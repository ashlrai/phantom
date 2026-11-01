import { isAbsolute } from 'node:path';
import { runContextReply } from '../core/fleet/context-result-bus.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';

const usage = 'Usage: ashlr fleet context-reply --snapshot <absolute-json> --prompt <absolute-text> --request-file <absolute-envelope-json> --reply-id <id> -- <program> [args...]';
export async function cmdFleetContextReply(args: string[], io: ContextWorkerIO = {}, bus: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nExplicit argv authorizes launch. Replies report runner process outcome only; routing is unauthenticated and grants no merge or completion authority.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--request-file', '--reply-id'].includes(key) || flags.has(key) ||
        i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), requestFile = flags.get('--request-file'), replyId = flags.get('--reply-id');
  if (!snapshot || !prompt || !requestFile || !replyId || ![snapshot, prompt, requestFile].every(isAbsolute)) return invalid();
  const result = await runContextReply({ snapshot, prompt, requestFile, replyId, argv: args.slice(split + 1) }, io, bus);
  // Static statuses and numeric codes only: no routing IDs or child/context data.
  (io.stderr ?? process.stderr).write(`${JSON.stringify({ workerExit: result.workerExit, replyReceipt: { status: result.replyReceipt.status } })}\n`);
  return result.exitCode;
}
