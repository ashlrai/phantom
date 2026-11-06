import { isAbsolute } from 'node:path';
import { deliverSpooledContextReply, runContextReplyDelivery } from '../core/fleet/context-reply-spool.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';

const usage = 'Usage: ashlr fleet context-deliver --snapshot <absolute-json> --prompt <absolute-text> --request-file <absolute-envelope-json> --reply-id <id> --spool-dir <absolute-directory> -- <program> [args...]\n'
  + '       ashlr fleet context-deliver --retry <absolute-spool-record>';
export async function cmdFleetContextDeliver(args: string[], io: ContextWorkerIO = {}, bus: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nRun mode executes the worker once and durably spools the reply when publication fails; `
      + `retry mode only republishes one explicit record. Outcomes are reported separately and grant no merge or completion authority.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  if (args.includes('--retry')) {
    // Retry mode: one explicit record, no argv and no other flags.
    if (args.length !== 2 || args[0] !== '--retry' || !isAbsolute(args[1]!) || args[1]!.includes('\0')) return invalid();
    const result = deliverSpooledContextReply(args[1]!, bus);
    (io.stderr ?? process.stderr).write(`${JSON.stringify({ workerExit: result.workerExit, delivery: result.delivery })}\n`);
    return result.exitCode;
  }
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--request-file', '--reply-id', '--spool-dir'].includes(key) || flags.has(key) ||
        i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), requestFile = flags.get('--request-file');
  const replyId = flags.get('--reply-id'), spoolDir = flags.get('--spool-dir');
  if (!snapshot || !prompt || !requestFile || !replyId || !spoolDir || ![snapshot, prompt, requestFile, spoolDir].every(isAbsolute)) return invalid();
  const result = await runContextReplyDelivery(
    { snapshot, prompt, requestFile, replyId, spoolDir, argv: args.slice(split + 1) }, io, bus);
  // Static statuses and numeric codes only: no routing IDs or child/context data.
  (io.stderr ?? process.stderr).write(`${JSON.stringify({ workerExit: result.workerExit, delivery: result.delivery })}\n`);
  return result.exitCode;
}
