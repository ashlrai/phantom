import { mkdirSync } from 'node:fs';
import { resolveNeedsMasonWithInbox } from '../core/fleet/needs-mason-relay.js';
import { listNeedsMason } from '../core/fleet/needs-mason-resolve.js';
import { NEEDS_MASON_REPLY_MAX } from '../core/fleet/needs-mason-resolve.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = `Usage: ashlr fleet needs [--json] [--runs-dir DIR]
               [--resolve NM-ID] [--reply \"TEXT\"]
  --runs-dir DIR  Read DIR/NEEDS-MASON.md (default: ASHLR_RUNS_DIR or ~/.ashlr-runs).
  --resolve ID    Resolve a needs-you item by id.
  --reply \"TEXT\"  Reply text (required when --resolve is used).`;

export async function cmdFleetNeeds(args: string[], deps: { list?: typeof listNeedsMason; resolve?: typeof resolveNeedsMasonWithInbox } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false, runsDir: string | undefined, resolveId: string | undefined, reply: string | undefined;
  let resolveSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else if (arg === '--resolve' && !resolveSeen && next && !next.startsWith('-')) { resolveId = next; resolveSeen = true; i++; }
    else if (arg === '--reply' && reply === undefined && next && !next.startsWith('-')) { reply = next; i++; }
    else { process.stderr.write(`${usage}\n`); return 2; }
  }
  if (reply !== undefined && resolveId === undefined) { process.stderr.write(`${usage}\n`); return 2; }
  if (resolveId !== undefined) {
    if (reply === undefined || reply.length === 0) {
      process.stderr.write('error: --resolve requires --reply\n');
      return 2;
    }
    if (reply.length > NEEDS_MASON_REPLY_MAX) {
      process.stderr.write(`error: reply exceeds ${NEEDS_MASON_REPLY_MAX} characters\n`);
      return 2;
    }
    const resolvedRuns = runsDir ?? process.env.ASHLR_RUNS_DIR;
    const busRoot = resolvedRuns ? `${resolvedRuns}/inbox` : undefined;
    if (busRoot) {
      try { mkdirSync(busRoot, { recursive: true }); } catch { /* best effort; bus handles missing dirs */ }
    }
    const rl = deps.resolve ?? resolveNeedsMasonWithInbox;
    const now = Date.now;
    let result: ReturnType<typeof rl>;
    try {
      result = await rl({ itemId: resolveId, reply }, { runsDir, source: 'cli', bus: { root: busRoot, now }, now });
    } catch { process.stderr.write('error: fleet needs resolution unavailable\n'); return 1; }
    if (json) console.log(JSON.stringify({ v: 1, item: resolveId, duplicate: result.duplicate ?? false, inbox: result.inbox, ...(result.ok ? {} : { error: result.code, detail: result.error }) }));
    else if (!result.ok) process.stderr.write(`error: ${result.code}: ${result.error}\n`);
    else process.stdout.write(`resolved ${resolveId}  inbox: ${result.inbox}${result.duplicate ? ' (duplicate)' : ''}\n`);
    return result.ok ? 0 : 1;
  }
  let items: ReturnType<typeof listNeedsMason>;
  try { items = (deps.list ?? listNeedsMason)({ runsDir }); }
  catch { process.stderr.write('error: fleet needs unavailable\n'); return 1; }
  if (json) console.log(JSON.stringify({ v: 1, count: items.length, items }));
  else if (!items.length) console.log('Nothing needs Mason.');
  else console.log(scrubSecrets([...items.map(item => `${item.id}  ${item.text}`), `${items.length} item(s) need Mason.`].join('\n')));
  return 0;
}
