import { dirname, isAbsolute } from 'node:path';
import { MAX_BUS_ENVELOPE_BYTES } from '../core/fleet/bus-envelope.js';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { postBusReply, replyResult, type ReplyDependencies, type ReplyResult } from '../core/fleet/bus-reply-post.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Convention loader entry; root/clock/output injection is programmatic only. */
export function cmdFleetBusReply(args: string[], options: BusInboxOptions = {},
  deps: ReplyDependencies & { output?: (text: string) => void } = {}): number {
  const output = deps.output ?? console.log;
  const emit = (result: ReplyResult): number => {
    try { output(JSON.stringify(sanitizePublicJson(result))); } catch { return 1; }
    return result.outcome === 'posted' || result.outcome === 'duplicate' ? 0
      : result.outcome === 'invalid-input' ? 2 : result.outcome === 'request-not-found' ? 3 : 4;
  };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output('ashlr fleet bus-reply --request-id <id> --reply-id <id> --body-file <absolute-json> [--json]\nRouting labels do not authenticate the responder. A reply does not mark work completed.\nBody must be a stable regular JSON object file (maximum 65536 bytes), without inReplyTo.\nRetries require the same explicit reply ID. Missing or expired requests are refused.');
    return 0;
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) { json = true; continue; }
    const match = /^(--request-id|--reply-id|--body-file)(?:=(.*))?$/.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(replyResult('invalid-input'));
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(replyResult('invalid-input'));
    values[match[1]!] = value;
  }
  const file = values['--body-file'], requestId = values['--request-id'], replyId = values['--reply-id'];
  if (!file || !isAbsolute(file) || !requestId || !replyId) return emit(replyResult('invalid-input'));
  const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES,
    remainingBytes: MAX_BUS_ENVELOPE_BYTES });
  if (!read.ok) return emit(replyResult('invalid-input'));
  let body: unknown;
  try { body = JSON.parse(read.text); } catch { return emit(replyResult('invalid-input')); }
  return emit(postBusReply(requestId, replyId, body, options, deps));
}
