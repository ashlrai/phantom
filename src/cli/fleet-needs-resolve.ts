import { resolveNeedsMasonWithInbox } from '../core/fleet/needs-mason-relay.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet needs-resolve <nm-id> [--reply TEXT] [--json] [--runs-dir DIR]';
const phrases = {
  invalid: 'invalid request',
  'reply-too-long': 'reply is too long',
  unknown: 'unknown item',
  'already-resolved': 'item already resolved',
};

export async function cmdFleetNeedsResolve(args: string[], deps: { resolve?: typeof resolveNeedsMasonWithInbox } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let itemId: string | undefined, reply: string | undefined, runsDir: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--reply' && reply === undefined && next !== undefined && !next.startsWith('-')) { reply = next; i++; }
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else if (/^nm-[0-9a-f]{12}$/.test(arg) && itemId === undefined) itemId = arg;
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  if (!itemId) { process.stderr.write(`${usage}\n`); return 2; }
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
