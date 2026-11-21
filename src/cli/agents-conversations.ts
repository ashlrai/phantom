import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';

/** `phm agents conversations`: thin argv adapter for core/fleet/agent-conversations.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const AGENTS_CONVERSATIONS_USAGE = `Usage: phm agents conversations [--agent <name>] [--waiting] [--blocked] [--job <id>] [--waiting-on <name>] [--json]

Agent-to-agent messages grouped into threads by reply chain: who is in each
thread, the latest subject, message count, last activity and one state:
waiting for reply (and on whom, for how long), answered, blocked or done.
Longest-waiting first, then newest. An agent no label proves reads "unknown agent".
--agent keeps threads that agent is in; --waiting keeps threads waiting for a reply;
--blocked keeps threads a blocker or failed report left unanswered;
--job keeps the threads that name one job — its job:<id> bucket or a member
message citing it — whole threads, never partial message lists;
--waiting-on keeps the waiting threads one agent owes a reply on — its own
labels or a group:<channel>:<topic> address of a channel it belongs to, never
a thread whose waiting message the agent itself sent.
--json prints agents.conversations.v1. Read only.`;

const JOB_ID = /^[\x21-\x7e]{1,128}$/;

export async function runAgentsConversationsCli(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error, options: BusInboxOptions = {}): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_CONVERSATIONS_USAGE); return 0; }
  let json = false, waitingOnly = false, blockedOnly = false, agent: string | undefined, job: string | undefined, waitingOn: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--waiting' && !waitingOnly) waitingOnly = true;
    else if (arg === '--blocked' && !blockedOnly) blockedOnly = true;
    else if (arg === '--agent' && agent === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { agent = value; i++; }
    else if (arg === '--job' && job === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { job = value; i++; }
    else if (arg === '--waiting-on' && waitingOn === undefined && value !== undefined && value !== '' && !value.startsWith('--')) { waitingOn = value; i++; }
    else { err(AGENTS_CONVERSATIONS_USAGE); return 2; }
  }
  if (job !== undefined && !JOB_ID.test(job)) { err('--job takes a job id (printable label, 1-128 chars).'); return 2; }
  const { formatAgentConversationsText, readAgentConversations } = await import('../core/fleet/agent-conversations.js');
  const result = readAgentConversations({ agent, waitingOnly, blockedOnly, job, waitingOn }, options);
  out(json ? JSON.stringify(result, null, 2) : formatAgentConversationsText(result));
  return result.source === 'unavailable' ? 1 : 0;
}
