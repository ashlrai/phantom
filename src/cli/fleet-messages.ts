/** The map's agent-to-agent message rows with the shared `phm messages` read filters. */
import { cmdFleetMapMessages } from './fleet-map-messages.js';

const usage = `Usage: phm fleet messages [--json] [--since <10m|2h|1d|ISO|epoch>] [--before <10m|2h|1d|ISO|epoch>] [--agent <name|lane>] [--with <name|lane>] [--kind <ask|reply|handoff|status|blocker>] [--priority <P0|P1|P2|P3>] [--job <id>] [--thread <label>] [--channel <name>] [--contains <text>] [--from <name|lane>] [--exclude-from <name|lane>] [--to <name|lane|label>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--limit <1-100>]

The map's agent-to-agent message rows (default: the last 15 minutes, newest
20): from, to, kind, time and a short redacted summary per row. Every filter
is the same vocabulary \`phm messages\` parses — see \`phm fleet map messages
--help\` for the full list. --json prints the row array, or null when the bus
is unreadable. Read only.`;
export async function cmdFleetMessages(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  return cmdFleetMapMessages(args, true);
}
