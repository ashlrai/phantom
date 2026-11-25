import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { CONVERSATION_STATES, type ConversationState } from '../core/fleet/agent-conversation-model.js';
import { AGENT_MESSAGE_KINDS, parseSince, type AgentMessageKind } from '../core/fleet/agent-messages.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';

/** `phm agents conversations`: thin argv adapter for core/fleet/agent-conversations.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const AGENTS_CONVERSATIONS_USAGE = `Usage: phm agents conversations [--agent <name>] [--with <name>] [--waiting] [--blocked] [--state <waiting|answered|blocked|done>] [--job <id>] [--waiting-on <name>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--in-reply-to <id>] [--id <envelope-id>] [--channel <name>] [--priority <P0|P1|P2|P3>] [--from <name>] [--exclude-from <name>] [--thread <label>] [--body-kind <kind>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>] [--kind <ask|reply|handoff|status|blocker>] [--limit <1..1024>] [--json]

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
question is what is still outstanding. --before keeps only the threads whose
last activity is strictly before its own cutoff on the same grammar — the
exclusive upper bound composing with --since into one [since, before)
window, so a thread stamped exactly at either bound never matches and
reaching a past slice of the thread list is one filtered read instead of
paging forward through everything newer; an inverted or empty window is an
honest empty list, never an error;
--contains keeps only the threads where at least one member message's
scrubbed one-line subject carries the needle as a case-insensitive
substring — the same text search phm messages --contains, agents bus
inbox --contains and channel read --contains apply, matched over the
rendered summaries, never the raw body — so "which thread is about X" is
one filtered read, whole threads like every other filter here;
--in-reply-to keeps only the threads where at least one member message's
body cites that envelope id through its own inReplyTo field — the same
own-property exact match phm messages --in-reply-to, agents bus inbox
--in-reply-to, channel read --in-reply-to, comms bus read|watch
--in-reply-to and fleet bus-follow --in-reply-to apply, never the replyTo
alias or a substring — so "which thread is the answer to envelope X in"
is one filtered read; --id keeps only the thread one member message's
own wire id strictly equals — at most one thread, since every member
message sits in exactly one — the same exact-envelope match phm messages
--id, agents bus inbox --id, channel read --id, agents bus wakes --id,
comms bus read|watch --id, fleet bus-follow --id and fleet_bus_inbox's id
apply, never a substring or a thread-key or body citation — so "which
thread is envelope X in" is one filtered read returning the whole thread
where phm messages --id reports only the one row;
--channel keeps only the threads where at least one member message is
addressed to group:<name>:* — the room's whole traffic under every topic,
the same raw address prefix phm messages --channel, agents bus inbox
--channel and channel read --channel match — so "which threads touch
channel X" is one filtered read, the value taking the strict channel-name
grammar;
--priority keeps only the threads where at least one member message
carries that exact P0..P3 band — the same match every other bus read's
--priority applies — so "which threads have urgent traffic" is one
filtered read, a member message with no recorded band never matching;
--from keeps only the threads where at least one member message was sent
under that agent's labels — a handle, agent:<handle>, stable id or alias
matching every label of that identity, the same sender-inclusion rule
every bus read's --from applies, decided on each member message's from so
a thread the agent only receives in never passes; --exclude-from drops
every thread where any member message was sent under that agent's labels
— the same sender-exclusion rule, composing with --from so a sender both
included and excluded matches nothing; --with narrows --agent to the
threads holding the two-way exchange between the two named agents — the
same pairwise rule phm messages --agent <a> --with <b> applies, decided
on each member message's from/to endpoints in either direction, each
side matching by the same name/identity-key rule — so "our thread" is
one filtered read while a thread where the two only share a third party
or a room never passes, and --with without --agent is a usage error,
never a widened read;
--thread keeps only the threads where at least one member message
declared that exact conversation bucket — a thread label, threadId,
job:<id> or origin key, strictly equal, never a substring — the same
own-field exact match phm messages --thread, agents bus inbox --thread,
channel read --thread and agents bus wakes --thread apply, so "the
conversation labelled X" is one filtered read while an undeclared reply
chain names no provable thread and never matches (its root envelope id
stays --id's match); --body-kind keeps only the threads where at least
one member message's body carries that exact kind discriminator — the
same busBodyKind own-field exact match agents bus inbox --body-kind,
channel read --body-kind and agents bus wakes --body-kind apply — so
"which threads carry work.post traffic" is one filtered read, a member
message whose body carries no discriminator never matching;
--result keeps only the threads where at least one member message is a
work.result receipt reporting that one outcome — the same
WORK_RESULT_OUTCOMES codes the work feed's --result filter and phm
messages --result validate, matched verbatim against the body's own
outcome field through busBodyResultOutcome, the same own-field exact
match agents bus inbox --result, channel read --result and agents bus
wakes --result apply — so "which threads carry a failed result" is one
filtered read, every other body kind and a work.result carrying no
outcome never matching;
--kind keeps only the threads where at least one member message's
classified kind is the value — ask, reply, handoff, status or blocker,
the same vocabulary phm messages --kind filters the flat timeline on —
so "which threads carry a blocker" is one filtered read of whole
threads; --limit caps the threads shown, longest-waiting order kept, while matched
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
  let state: ConversationState | undefined, limit: number | undefined, sinceRaw: string | undefined, beforeRaw: string | undefined, contains: string | undefined;
  let inReplyTo: string | undefined, id: string | undefined, channel: string | undefined, priority: BusPriority | undefined, from: string | undefined, excludeFrom: string | undefined;
  let withPeer: string | undefined, thread: string | undefined, bodyKind: string | undefined;
  let kind: AgentMessageKind | undefined, resultOutcome: WorkResultOutcome | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--waiting' && !waitingOnly) waitingOnly = true;
    else if (arg === '--blocked' && !blockedOnly) blockedOnly = true;
    else if (arg === '--agent' && agent === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { agent = value; i++; }
    else if (arg === '--job' && job === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { job = value; i++; }
    else if (arg === '--waiting-on' && waitingOn === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { waitingOn = value; i++; }
    else if (arg === '--since' && sinceRaw === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { sinceRaw = value; i++; }
    else if (arg === '--before' && beforeRaw === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { beforeRaw = value; i++; }
    else if (arg === '--contains' && contains === undefined && value !== undefined && value.trim() !== '' &&
      value.length <= CONTAINS_MAX && !value.startsWith('--')) { contains = value; i++; }
    else if (arg === '--in-reply-to' && inReplyTo === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { inReplyTo = value; i++; }
    else if (arg === '--id' && id === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { id = value; i++; }
    else if (arg === '--channel' && channel === undefined && value !== undefined && agentChannelNameSchema.safeParse(value).success) { channel = value; i++; }
    else if (arg === '--priority' && priority === undefined && value !== undefined &&
      (BUS_PRIORITIES as readonly string[]).includes(value)) { priority = value as BusPriority; i++; }
    else if (arg === '--from' && from === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { from = value; i++; }
    else if (arg === '--exclude-from' && excludeFrom === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { excludeFrom = value; i++; }
    else if (arg === '--with' && withPeer === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { withPeer = value; i++; }
    else if (arg === '--thread' && thread === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { thread = value; i++; }
    else if (arg === '--body-kind' && bodyKind === undefined && value !== undefined && JOB_ID.test(value) && !value.startsWith('--')) { bodyKind = value; i++; }
    else if (arg === '--result' && resultOutcome === undefined && value !== undefined && !value.startsWith('--')) {
      if (!(WORK_RESULT_OUTCOMES as readonly string[]).includes(value)) {
        err(`--result takes one of ${WORK_RESULT_OUTCOMES.join(', ')}.`);
        return 2;
      }
      resultOutcome = value as WorkResultOutcome; i++;
    }
    else if (arg === '--kind' && kind === undefined && value !== undefined && !value.startsWith('--')) {
      if (!(AGENT_MESSAGE_KINDS as readonly string[]).includes(value)) {
        err(`--kind takes one of ${AGENT_MESSAGE_KINDS.join(', ')}.`);
        return 2;
      }
      kind = value as AgentMessageKind; i++;
    }
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
  if (withPeer !== undefined && agent === undefined) { err('--with takes the other agent and needs --agent.'); return 2; }
  // Relative cutoffs resolve against the read's own clock so a frozen `now`
  // in tests and the live clock in production agree on "15m ago".
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw, options.now?.() ?? Date.now());
  if (sinceRaw !== undefined && since === null) { err('--since takes 15m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw, options.now?.() ?? Date.now());
  if (beforeRaw !== undefined && before === null) { err('--before takes 15m, 2h, 1d, epoch ms or an ISO time.'); return 2; }
  const { formatAgentConversationsText, readAgentConversations } = await import('../core/fleet/agent-conversations.js');
  const result = readAgentConversations({ agent, waitingOnly, blockedOnly, job, waitingOn, state, since: since ?? undefined, before: before ?? undefined, contains, inReplyTo, id, channel, priority, from, excludeFrom, with: withPeer, thread, bodyKind, result: resultOutcome, kind, limit }, options);
  out(json ? JSON.stringify(result, null, 2) : formatAgentConversationsText(result));
  return result.source === 'unavailable' ? 1 : 0;
}
