import type { Readable } from 'node:stream';
import { NEEDS_MASON_REPLY_MAX } from '../core/fleet/needs-mason-resolve.js';
import { resolveNeedsMasonWithInbox } from '../core/fleet/needs-mason-relay.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet needs-resolve <nm-id> [--reply TEXT | --reply-stdin] [--json] [--runs-dir DIR]\n--reply-stdin reads UTF-8, removes one final LF or CRLF, and preserves embedded newlines.';
const phrases = {
  invalid: 'invalid request',
  'reply-too-long': 'reply is too long',
  unknown: 'unknown item',
  'already-resolved': 'item already resolved',
};

export async function cmdFleetNeedsResolve(args: string[], deps: { resolve?: typeof resolveNeedsMasonWithInbox; stdin?: Readable } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let itemId: string | undefined, reply: string | undefined, runsDir: string | undefined, json = false, replyStdin = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--reply-stdin' && !replyStdin) replyStdin = true;
    else if (arg === '--reply' && reply === undefined && next !== undefined && !next.startsWith('-')) { reply = next; i++; }
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else if (/^nm-[0-9a-f]{12}$/.test(arg) && itemId === undefined) itemId = arg;
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  if (!itemId || (replyStdin && reply !== undefined)) { process.stderr.write(`${usage}\n`); return 2; }
  if (replyStdin) {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      // Three UTF-8 bytes per UTF-16 code unit, plus a possible final CRLF.
      const maxBytes = NEEDS_MASON_REPLY_MAX * 3 + 2;
      const stream = deps.stdin ?? process.stdin;
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += buffer.length;
        if (bytes > maxBytes) { process.stderr.write('Refused: reply is too long\n'); return 1; }
        chunks.push(buffer);
      }
      reply = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      if (!reply.trim() || reply.length > NEEDS_MASON_REPLY_MAX) {
        process.stderr.write('Refused: empty or oversized stdin reply\n'); return 1;
      }
    } catch { process.stderr.write('error: could not read reply from stdin\n'); return 1; }
  }
  let result: Awaited<ReturnType<typeof resolveNeedsMasonWithInbox>>;
  try { result = await (deps.resolve ?? resolveNeedsMasonWithInbox)({ itemId, ...(reply !== undefined ? { reply } : {}) }, { runsDir, source: 'cli' }); }
  catch { result = { ok: false, code: 'unavailable', error: '', inbox: 'skipped' }; }
  const status = result.ok ? 'resolved' : result.code;
  if (json) console.log(scrubSecrets(JSON.stringify({ v: 1, status, itemId, inbox: result.inbox })));
  else if (result.ok) {
    const suffix = result.inbox === 'appended' ? ' Reply sent to the planners.' : result.inbox === 'failed' ? ' Reply did not reach the planner inbox.' : '';
    console.log(scrubSecrets(`Resolved ${itemId}.${suffix}`));
  } else if (result.code === 'unavailable') process.stderr.write('error: needs-you file unavailable\n');
  else process.stderr.write(`Refused: ${phrases[result.code]}\n`);
  return result.ok ? 0 : 1;
}
