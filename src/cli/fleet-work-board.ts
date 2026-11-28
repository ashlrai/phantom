/** `ashlr fleet work-board` — list the recent work requests sitting in the
 * durable bus inbox, each classified RECEIVED / ASSIGNED / RUNNING / BLOCKED /
 * VERIFIED by the same evidence rule as `fleet work-trace`, so a Slack or
 * iMessage thread ref can be traced back to its hashed inbox id. Read-only:
 * no writes, no network; labels and tokens grant no authority. */
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard } from '../core/comms/work-board.js';
import { WORK_ITEM_STATES, type WorkItemState } from '../core/comms/work-item-state.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { busReadContains } from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';

const usage = 'Usage: ashlr fleet work-board [--root <absolute>] [--thread <channel_ref>] [--state <RECEIVED|ASSIGNED|RUNNING|BLOCKED|VERIFIED>] [--since <15m|2h|1d|epoch-ms|ISO>] [--before <15m|2h|1d|epoch-ms|ISO>] [--channel <name>] [--topic <topic>] [--id <envelope-id>] [--to <ref>] [--from <ref>] [--exclude-from <ref>] [--priority P0..P3] [--job <id>] [--body-kind <kind>] [--result <reserved|admitted|complete|failed>] [--contains <text>] [--limit <1..100>] [--json]\n'
  + 'Prints one line per request: ID STATE as-of=... source=... owner-missing=... owner=... claim=... channel=... ref=...,\n'
  + 'then a footer: items=N truncated=yes|no inbox=ok|unavailable as-of=<now>, plus claims=missing|unavailable\n'
  + 'when the claims table is absent or unreadable (a validated table, even an empty one, prints no claims token).\n'
  + '--state keeps only items the shared classifier placed in that state; --since/--before keep only requests whose\n'
  + 'recorded receivedAt falls inside the [since, before) window — since inclusive, before exclusive, the same bound\n'
  + 'every bus read applies. --channel keeps only requests addressed to group:<name>:* — the room\'s whole traffic\n'
  + 'under every topic — and --topic keeps only requests addressed to a well-formed group:<room>:<topic> label\n'
  + 'carrying that exact topic component, composing into one room AND one topic; both decide on the request\'s own\n'
  + 'to label with no registry dependence, the same raw rules every other bus read\'s --channel/--topic applies.\n'
  + '--id keeps only the request whose own wire id is strictly equal, the same exact-envelope match every bus\n'
  + 'read\'s --id applies. --to keeps only requests addressed to that agent under the shared pending-address rule\n'
  + 'bus next claims by, --from/--exclude-from keep or drop one sender identity, --priority one P0..P3 band,\n'
  + '--job requests naming one job, --body-kind one exact body discriminator, --result one work.result outcome\n'
  + 'and --contains a case-insensitive substring of the scrubbed one-line summary — the same shared bus-read\n'
  + 'filters every other bus read applies, decided on each request envelope\'s own fields. The board lists\n'
  + 'requests only, so the reply-citation filter never applies — every listed request is by definition not a\n'
  + 'reply — and --thread here is the channel_ref scope, not the v2 body thread label the flag name carries\n'
  + 'on other bus reads. The footer then also prints state=<S> and matched=<n>,\n'
  + 'the true filtered total across the whole settled scan, so items may be a newest-first slice of it. Read-only.';

/** The shared `15m|2h|1d|epoch-ms|ISO` grammar every bus read's time flag
 * takes, resolved to a non-negative safe epoch-ms bound or null. */
function timeBound(value: string): number | null {
  const ms = parseSince(value);
  return ms !== null && Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

export async function cmdFleetWorkBoard(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root: string | undefined, thread: string | undefined, limit: number | undefined, state: WorkItemState | undefined,
    since: number | undefined, before: number | undefined, channel: string | undefined, topic: string | undefined,
    id: string | undefined, to: string | undefined, from: string | undefined, excludeFrom: string | undefined,
    priority: BusPriority | undefined, job: string | undefined, bodyKind: string | undefined,
    result: WorkResultOutcome | undefined, contains: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--root' && key !== '--thread' && key !== '--limit' && key !== '--state'
      && key !== '--since' && key !== '--before' && key !== '--channel' && key !== '--topic' && key !== '--id'
      && key !== '--to' && key !== '--from' && key !== '--exclude-from' && key !== '--priority'
      && key !== '--job' && key !== '--body-kind' && key !== '--result' && key !== '--contains') {
      console.error(usage); return 2;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--root' && root === undefined) root = value;
    else if (key === '--thread' && thread === undefined) thread = value;
    else if (key === '--channel' && channel === undefined && agentChannelNameSchema.safeParse(value).success) channel = value;
    else if (key === '--topic' && topic === undefined && agentChannelNameSchema.safeParse(value).success) topic = value;
    else if (key === '--id' && id === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) id = value;
    else if (key === '--to' && to === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) to = value;
    else if (key === '--from' && from === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) from = value;
    else if (key === '--exclude-from' && excludeFrom === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) excludeFrom = value;
    else if (key === '--job' && job === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) job = value;
    else if (key === '--body-kind' && bodyKind === undefined && /^[\x21-\x7e]{1,128}$/.test(value)) bodyKind = value;
    else if (key === '--priority' && priority === undefined && (BUS_PRIORITIES as readonly string[]).includes(value)) priority = value as BusPriority;
    else if (key === '--result' && result === undefined && (WORK_RESULT_OUTCOMES as readonly string[]).includes(value)) result = value as WorkResultOutcome;
    else if (key === '--contains' && contains === undefined && busReadContains(value) !== null) contains = value;
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
    ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }),
    ...(channel === undefined ? {} : { channel }), ...(topic === undefined ? {} : { topic }),
    ...(id === undefined ? {} : { id }), ...(to === undefined ? {} : { to }),
    ...(from === undefined ? {} : { from }), ...(excludeFrom === undefined ? {} : { excludeFrom }),
    ...(priority === undefined ? {} : { priority }), ...(job === undefined ? {} : { job }),
    ...(bodyKind === undefined ? {} : { bodyKind }), ...(result === undefined ? {} : { result }),
    ...(contains === undefined ? {} : { contains }) });
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
  const stateNote = board.state === undefined ? '' : ` state=${board.state}`;
  // `matched` rides any narrowing filter — state or a time window — so a
  // since/before read reports the true filtered total just like --state does.
  const matchedNote = board.matched === undefined ? '' : ` matched=${board.matched}`;
  const windowNote = `${since === undefined ? '' : ` since=${new Date(since).toISOString()}`}`
    + `${before === undefined ? '' : ` before=${new Date(before).toISOString()}`}`;
  console.log(`items=${board.items.length}${stateNote}${matchedNote}${windowNote} truncated=${board.truncated ? 'yes' : 'no'} inbox=${board.inbox} as-of=${asOf}${claimsNote}`);
  return 0;
}
