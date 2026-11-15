/** `ashlr fleet work-board` — list the recent work requests sitting in the
 * durable bus inbox, each classified RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED by the same evidence rule as `fleet work-trace`, so a Slack or
 * iMessage thread ref can be traced back to its hashed inbox id. Read-only:
 * no writes, no network; labels and tokens grant no authority. */
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard } from '../core/comms/work-board.js';

const usage = 'Usage: ashlr fleet work-board [--root <absolute>] [--thread <channel_ref>] [--limit <1..100>] [--json]\n'
  + 'Prints one line per request: ID STATE as-of=... source=... owner-missing=... owner=... claim=... channel=... ref=...,\n'
  + 'then a footer: items=N truncated=yes|no inbox=ok|unavailable as-of=<now>, plus claims=missing|unavailable\n'
  + 'when the claims table is absent or unreadable (a validated table, even an empty one, prints no claims token).\n'
  + 'Read-only.';

export async function cmdFleetWorkBoard(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, thread: string | undefined, limit: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--root' && key !== '--thread' && key !== '--limit') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--thread' && thread === undefined) thread = value;
    else if (key === '--limit' && limit === undefined && /^\d+(?![\s\S])/.test(value)
      && Number(value) >= 1 && Number(value) <= 100) limit = Number(value);
    else { console.error(usage); return 2; }
  }
  if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) { console.error(usage); return 2; }
  const now = Date.now();
  const board = listWorkBoard({ root: root ?? join(ashlrHome(), 'fleet'), now, limit, channelRef: thread });
  const asOf = new Date(now).toISOString();
  if (json) { console.log(JSON.stringify({ ...board, asOf })); return 0; }
  for (const item of board.items) {
    console.log(`${item.id} ${item.state} as-of=${item.asOf} source=${item.source} `
      + `owner-missing=${item.missing.includes('named owner') ? 'yes' : 'no'} `
      + `owner=${item.owner ?? 'unknown'} claim=${item.claimReceipt ?? 'unknown'} `
      + `channel=${item.channel} ref=${item.channelRef ?? 'none'}`);
  }
  // The claims table state rides the footer only when it is not the nominal
  // readable state, so a missing or unreadable table can never pass as
  // verified absence of ownership; 'available' keeps the legacy footer.
  const claimsNote = board.claims !== undefined && board.claims !== 'available' ? ` claims=${board.claims}` : '';
  console.log(`items=${board.items.length} truncated=${board.truncated ? 'yes' : 'no'} inbox=${board.inbox} as-of=${asOf}${claimsNote}`);
  return 0;
}
