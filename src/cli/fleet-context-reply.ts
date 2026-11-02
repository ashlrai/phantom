import { isAbsolute } from 'node:path';
import { runContextReply, type ContextReplyIO } from '../core/fleet/context-result-bus.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';

const usage = 'Usage: ashlr fleet context-reply --snapshot <absolute-json> --prompt <absolute-text> --request-file <absolute-envelope-json> --reply-id <id> [--timeout-ms <1..3600000>] [--check [--budget-seconds <n>]] -- <program> [args...]';
export async function cmdFleetContextReply(args: string[], io: ContextReplyIO = {}, bus: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\n--check opts in to the local gate after a successful worker; --budget-seconds requires --check. Without --check, replies report the runner process outcome only. Routing is unauthenticated and grants no merge or completion authority.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split;) {
    const key = args[i]!, value = args[i + 1];
    if (key === '--check' && !flags.has(key)) { flags.set(key, 'true'); i++; continue; }
    if (!['--snapshot', '--prompt', '--request-file', '--reply-id', '--timeout-ms', '--budget-seconds'].includes(key) || flags.has(key) ||
        i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
    i += 2;
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'), requestFile = flags.get('--request-file'), replyId = flags.get('--reply-id');
  const timeout = flags.get('--timeout-ms');
  const timeoutMs = timeout !== undefined && /^\d+(?![\s\S])/.test(timeout) ? Number(timeout) : NaN;
  const budget = flags.get('--budget-seconds'), budgetSeconds = budget === undefined ? undefined : Number(budget);
  if (!snapshot || !prompt || !requestFile || !replyId || ![snapshot, prompt, requestFile].every(isAbsolute) ||
      (timeout !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)) ||
      (budget !== undefined && (!flags.has('--check') || !Number.isFinite(budgetSeconds) || budgetSeconds! <= 0))) return invalid();
  const result = await runContextReply({ snapshot, prompt, requestFile, replyId, argv: args.slice(split + 1),
    ...(timeout === undefined ? {} : { timeoutMs }), ...(flags.has('--check') ? { check: { budgetSeconds } } : {}) }, io, bus);
  // Static statuses and numeric codes only: no routing IDs or child/context data.
  (io.stderr ?? process.stderr).write(`${JSON.stringify({ workerExit: result.workerExit, replyReceipt: { status: result.replyReceipt.status },
    ...(result.verification === undefined ? {} : { verification: result.verification }) })}\n`);
  return result.exitCode;
}
