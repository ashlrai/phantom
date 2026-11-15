/** `ashlr fleet work-result` — post a result receipt for a bus work item as
 * exactly one evidence-shaped reply body: `verified` {pr,head}, `verified`
 * {tests}, `verified` {artifact} or `blocked` {dependency}, the only shapes
 * work-item-bus-evidence.ts reads. The board, work-trace and board-notify
 * then classify the item VERIFIED or BLOCKED. A receipt is evidence, never
 * authority: nothing here completes or releases a claim, and routing labels
 * do not authenticate the responder. */
import { isAbsolute } from 'node:path';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { postBusReply, replyResult, type ReplyDependencies, type ReplyResult } from '../core/fleet/bus-reply-post.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { workResultBody } from '../core/comms/work-result-body.js';

const usage = `ashlr fleet work-result --request-id <id> --reply-id <id> (--pr <n> --head <sha> | --tests <text> | --artifact <text> | --blocked <dependency>) [--root <absolute-path>] [--json]
Posts exactly one result form as a bus reply body: verified {pr,head}, verified {tests}, verified {artifact} or blocked {dependency}.
A result receipt is evidence, not authority: it does not complete or release a claim, and routing labels do not authenticate the responder.
--root selects the local store. Retries require the same explicit reply ID. Missing or expired requests are refused.`;

const FLAG = /^(--request-id|--reply-id|--pr|--head|--tests|--artifact|--blocked|--root)(?:=(.*))?$/;

/** Convention loader entry; root/clock/output injection is programmatic only. */
export async function cmdFleetWorkResult(args: string[], options: BusInboxOptions = {},
  deps: ReplyDependencies & { output?: (text: string) => void } = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const emit = (result: ReplyResult): number => {
    try { output(JSON.stringify(sanitizePublicJson(result))); } catch { return 1; }
    return result.outcome === 'posted' || result.outcome === 'duplicate' ? 0
      : result.outcome === 'invalid-input' ? 2 : result.outcome === 'request-not-found' ? 3 : 4;
  };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output(usage);
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) { json = true; continue; }
    const match = FLAG.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(replyResult('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(replyResult('invalid-input'));
    values[match[1]!] = value;
  }
  const requestId = values['--request-id'], replyId = values['--reply-id'], root = values['--root'];
  if (!requestId || !replyId || (root !== undefined && (!isAbsolute(root) || root.includes('\0')))) {
    return emit(replyResult('invalid-input'));
  }
  const body = workResultBody({ pr: values['--pr'], head: values['--head'], tests: values['--tests'],
    artifact: values['--artifact'], blocked: values['--blocked'] });
  if (!body) return emit(replyResult('invalid-input'));
  return emit(postBusReply(requestId, replyId, body, root === undefined ? options : { ...options, root }, deps));
}
