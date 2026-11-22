import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { CONVERSATION_STATES, type ConversationState } from '../core/fleet/agent-conversation-model.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** `phm agents conversations`: thin argv adapter for core/fleet/agent-conversations.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const AGENTS_CONVERSATIONS_USAGE = `Usage: phm agents conversations [--agent <name>] [--waiting] [--blocked] [--state <waiting|answered|blocked|done>] [--job <id>] [--waiting-on <name>] [--since <15m|2h|1d|ISO>] [--contains <text>] [--limit <1..1024>] [--json]

Agent-to-agent messages grouped into threads by reply chain: who is in each
thread, the latest subject, message count, last activity and one state:
waiting for reply (and on whom, for how long), answered, blocked or done.
Longest-waiting first, then newest. An agent no label proves reads "unknown agent".
--agent keeps threads that agent is in; --waiting keeps threads waiting for a reply;
--blocked keeps threads a blocker or failed report left unanswered;
--state keeps threads in one state — waiting, answered, blocked or done — the
general form of --waiting/--blocked, which stay conjunctive with it (a thread
cannot be two states, so contradictory filters are an honest empty list);
--job keeps the threads that name one job — its job:<id> bucket or a member
message citing it — whole threads, never partial message lists;
--waiting-on keeps the waiting threads one agent owes a reply on — its own
labels or a group:<channel>:<topic> address of a channel it belongs to, never
a thread whose waiting message the agent itself sent;
--since keeps the threads whose last activity is at or after the cutoff —
15m, 2h, 1d, epoch ms or an ISO time, the same grammar phm messages --since
takes — so "what moved lately" is one filtered read; a dormant thread drops
out even while it still waits, so pair it with --waiting or --state when the
question is what is still outstanding;
--contains keeps only the threads where at least one member message's
scrubbed one-line subject carries the needle as a case-insensitive
substring — the same text search phm messages --contains, agents bus
inbox --contains and channel read --contains apply, matched over the
rendered summaries, never the raw body — so "which thread is about X" is
one filtered read, whole threads like every other filter here;
--limit caps the threads shown, longest-waiting order kept, while matched
still reports the full filtered count.
--json prints agents.conversations.v1. Read only.`;

const JOB_ID = /^[\x21-\x7e]{1,128}$/;
const LIMIT_MAX = 1024;
/** Same bound every bus read's `--contains` accepts; the subjects it matches are already clipped far shorter. */
const CONTAINS_MAX = 512;

export async function runAgentsConversationsCli(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error, options: BusInboxOptions = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_CONVERSATIONS_USAGE); return 0; }
  let json = false, waitingOnly = false, blockedOnly = false, agent: string | undefined, job: string | undefined, waitingOn: string | undefined;
  let state: ConversationState | undefined, limit: number | undefined, sinceRaw: string | undefined, contains: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--waiting' && !waitingOnly) waitingOnly = true;
    else if (arg === '--blocked' && !blockedOnly) blockedOnly = true;
    else if (arg === '--agent' && agent === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { agent = value; i++; }
    else if (arg === '--job' && job === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { job = value; i++; }
    else if (arg === '--waiting-on' && waitingOn === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { waitingOn = value; i++; }
    else if (arg === '--since' && sinceRaw === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { sinceRaw = value; i++; }
    else if (arg === '--contains' && contains === undefined && value !== undefined && value.trim() !== '' &&
      value.length <= CONTAINS_MAX && !value.startsWith('--')) { contains = value; i++; }
    else if (arg === '--state' && state === undefined && value !== undefined && !value.startsWith('--')) {
      if (!(CONVERSATION_STATES as readonly string[]).includes(value)) {
        err(`--state takes one of ${CONVERSATION_STATES.join(', ')}.`);
        return 2;
      }
      state = value as ConversationState; i++;
    }
    else if (arg === '--limit' && limit === undefined && value !== undefined && /^[1-9][0-9]*$/.test(value) && Number(value) <= LIMIT_MAX) { limit = Number(value); i++; }
    else { err(AGENTS_CONVERSATIONS_USAGE); return 2; }
  }
  if (job !== undefined && !JOB_ID.test(job)) { err('--job takes a job id (printable label, 1-128 chars).'); return 2; }
  // Relative cutoffs resolve against the read's own clock so a frozen `now`
  // in tests and the live clock in production agree on "15m ago".
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw, options.now?.() ?? Date.now());
  if (sinceRaw !== undefined && since === null) { err('--since takes 15m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  const { formatAgentConversationsText, readAgentConversations } = await import('../core/fleet/agent-conversations.js');
  const result = readAgentConversations({ agent, waitingOnly, blockedOnly, job, waitingOn, state, since: since ?? undefined, contains, limit }, options);
  out(json ? JSON.stringify(result, null, 2) : formatAgentConversationsText(result));
  return result.source === 'unavailable' ? 1 : 0;
}
