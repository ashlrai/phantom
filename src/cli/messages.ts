/** `phm messages`: thin argv layer over core/fleet/agent-messages.ts. */
export const MESSAGES_USAGE = `Usage: phm messages [--since <15m|2h|1d|ISO>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--limit <n>] [--text]
Agent-to-agent messages on the local agent bus, newest first: id, ts, priority,
from, to, kind (ask, reply, handoff, status, blocker), a one-line scrubbed
summary, and the related job or PR when known. --agent with --with shows only
what those two said to each other; --kind keeps only one classified kind;
--priority keeps only one envelope band; --job keeps only the messages that
name one job — its job link, a live jobState citation or the job:<id>
conversation — so one job's whole bus traffic is a single filtered read.
JSON by default; --text for
people. Read-only.
Damaged bus records are skipped and counted. Exit 0 read, 1 bus unreadable, 2 bad usage.`;

export async function cmdMessages(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(MESSAGES_USAGE); return 0; }
  let text = false;
  const values: { since?: string; agent?: string; with?: string; kind?: string; priority?: string; job?: string; limit?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--text') { text = true; continue; }
    if (arg === '--json') continue;
    const key = arg === '--since' ? 'since' : arg === '--agent' ? 'agent' : arg === '--with' ? 'with'
      : arg === '--kind' ? 'kind' : arg === '--priority' ? 'priority' : arg === '--job' ? 'job' : arg === '--limit' ? 'limit' : null;
    const value = args[i + 1];
    if (!key || values[key] !== undefined || value === undefined || value.startsWith('--')) { console.error(MESSAGES_USAGE); return 2; }
    values[key] = value; i++;
  }
  const core = await import('../core/fleet/agent-messages.js');
  const parsed = core.parseAgentMessagesQuery(values);
  if (!parsed.ok) { console.error(text ? parsed.error : JSON.stringify({ error: parsed.error })); return 2; }
  const result = core.readAgentMessages(parsed.query);
  console.log(text ? core.formatAgentMessagesText(result) : JSON.stringify(result, null, 2));
  return result.source === 'unavailable' ? 1 : 0;
}
