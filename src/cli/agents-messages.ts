/** `phm agents messages`: thin argv adapter for core/fleet/agents-messages.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const AGENTS_MESSAGES_USAGE = `Usage: phm agents messages [--since 1h] [--before <10m|2h|1d|ISO|epoch>] [--limit N] [--json]

Recent agent-to-agent messages from the agent bus (default: the last hour,
newest 50): time, from, to, kind, a summary of at most 160 characters and the
thread when the message names one. --before keeps only messages received
strictly before its cutoff, so --since and --before read one closed
[since, before) window. from and to are the node ids the map draws
(leader, lane:<name>, job:<id>); an agent the map does not draw is "unknown".
--json prints agents.messages.v1 (schema, version, messages[], pairs[] with the
message count and last 5 summaries per line). Read only.`;

export async function runAgentsMessagesCli(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_MESSAGES_USAGE); return 0; }
  let json = false, since: string | undefined, before: string | undefined, limit: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--since' && since === undefined && value !== undefined) { since = value; i++; }
    else if (arg === '--before' && before === undefined && value !== undefined) { before = value; i++; }
    else if (arg === '--limit' && limit === undefined && value !== undefined) { limit = value; i++; }
    else { err(AGENTS_MESSAGES_USAGE); return 2; }
  }
  const { formatAgentsMessagesText, readAgentsMessages } = await import('../core/fleet/agents-messages.js');
  const read = readAgentsMessages({ since, before, limit });
  if (!read.ok) { err(read.error); return 2; }
  out(json ? JSON.stringify(read.result, null, 2) : formatAgentsMessagesText(read.result));
  return read.result.source === 'unavailable' ? 1 : 0;
}
