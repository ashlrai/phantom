/** `ashlr fleet work-board` — list the recent work requests sitting in the
 * durable bus inbox, each classified RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED by the same evidence rule as `fleet work-trace`, so a Slack or
 * iMessage thread ref can be traced back to its hashed inbox id. Read-only:
 * no writes, no network; labels and tokens grant no authority. */
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard, type WorkBoardItem } from '../core/comms/work-board.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { WORK_ITEM_STATES, type WorkItemState } from '../core/comms/work-item-state.js';
import { parseSince } from '../core/fleet/agent-messages.js';

const usage = 'Usage: ashlr fleet work-board [--root <absolute>] [--thread <channel_ref>] [--state <RECEIVED|ASSIGNED|RUNNING|BLOCKED|VERIFIED>] [--since <15m|2h|1d|epoch-ms|ISO>] [--before <15m|2h|1d|epoch-ms|ISO>] [--limit <1..100>] [--json]\n'
  + 'Prints one line per request: ID STATE as-of=... source=... owner-missing=... owner=... claim=... channel=... ref=...,\n'
  + 'BLOCKED and VERIFIED rows append their available dependency or proof fields.\n'
  + 'then a footer: items=N truncated=yes|no inbox=ok|unavailable as-of=<now>, plus claims=missing|unavailable\n'
  + 'when the claims table is absent or unreadable (a validated table, even an empty one, prints no claims token).\n'
  + '--state keeps only items the shared classifier placed in that state; --since/--before keep only requests whose\n'
  + 'recorded receivedAt falls inside the [since, before) window — since inclusive, before exclusive, the same bound\n'
  + 'every bus read applies. The footer then also prints state=<S> and matched=<n>, the true filtered total across\n'
  + 'the whole settled scan, so items may be a newest-first slice of it. Read-only.';

function resultText(item: WorkBoardItem): string {
  const result = item.result;
  if (!result) return '';
  // eslint-disable-next-line no-control-regex
  const clean = (value: string) => scrubSecrets(value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200);
  if (item.state === 'BLOCKED' && result.kind === 'blocked') return ` dependency=${clean(result.dependency)}`;
  if (item.state !== 'VERIFIED' || result.kind !== 'verified') return '';
  return [result.pr === null ? '' : ` pr=${result.pr}`,
    ...(['head', 'tests', 'artifact'] as const).map(key => result[key] === null ? '' : ` ${key}=${clean(result[key])}`)].join('');
}

/** The shared `15m|2h|1d|epoch-ms|ISO` grammar every bus read's time flag
 * takes, resolved to a non-negative safe epoch-ms bound or null. */
function timeBound(value: string): number | null {
  const ms = parseSince(value);
  return ms !== null && Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

export async function cmdFleetWorkBoard(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, thread: string | undefined, limit: number | undefined, state: WorkItemState | undefined,
    since: number | undefined, before: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--root' && key !== '--thread' && key !== '--limit' && key !== '--state'
      && key !== '--since' && key !== '--before') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--thread' && thread === undefined) thread = value;
    else if (key === '--state' && state === undefined && (WORK_ITEM_STATES as readonly string[]).includes(value)) state = value as WorkItemState;
    else if (key === '--limit' && limit === undefined && /^\d+(?![\s\S])/.test(value)
      && Number(value) >= 1 && Number(value) <= 100) limit = Number(value);
    else if (key === '--since' && since === undefined) {
      const ms = timeBound(value);
      if (ms === null) { console.error(usage); return 2; }
      since = ms;
    }
    else if (key === '--before' && before === undefined) {
      const ms = timeBound(value);
      if (ms === null) { console.error(usage); return 2; }
      before = ms;
    }
    else { console.error(usage); return 2; }
  }
  if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) { console.error(usage); return 2; }
  const now = Date.now();
  const board = listWorkBoard({ root: root ?? join(ashlrHome(), 'fleet'), now, limit, channelRef: thread, state,
    ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }) });
  const asOf = new Date(now).toISOString();
  if (json) { console.log(JSON.stringify({ ...board, asOf })); return 0; }
  for (const item of board.items) {
    console.log(`${item.id} ${item.state} as-of=${item.asOf} source=${item.source} `
      + `owner-missing=${item.missing.includes('named owner') ? 'yes' : 'no'} `
      + `owner=${item.owner ?? 'unknown'} claim=${item.claimReceipt ?? 'unknown'} `
      + `channel=${item.channel} ref=${item.channelRef ?? 'none'}` + resultText(item));
  }
  // The claims table state rides the footer only when it is not the nominal
  // readable state, so a missing or unreadable table can never pass as
  // verified absence of ownership; 'available' keeps the legacy footer.
  const claimsNote = board.claims !== undefined && board.claims !== 'available' ? ` claims=${board.claims}` : '';
  const stateNote = board.state === undefined ? '' : ` state=${board.state}`;
  // `matched` rides any narrowing filter — state or a time window — so a
  // since/before read reports the true filtered total just like --state does.
  const matchedNote = board.matched === undefined ? '' : ` matched=${board.matched}`;
  const windowNote = `${since === undefined ? '' : ` since=${new Date(since).toISOString()}`}`
    + `${before === undefined ? '' : ` before=${new Date(before).toISOString()}`}`;
  console.log(`items=${board.items.length}${stateNote}${matchedNote}${windowNote} truncated=${board.truncated ? 'yes' : 'no'} inbox=${board.inbox} as-of=${asOf}${claimsNote}`);
  return 0;
}
