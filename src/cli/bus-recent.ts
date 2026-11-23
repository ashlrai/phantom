/** `phm bus recent`: thin argv adapter for core/fleet/bus-recent.ts. Exit 0 read, 1 bus unreadable, 2 bad usage. */
export const BUS_RECENT_USAGE = `Usage: phm bus recent [--since 5m] [--before <10m|2h|1d|ISO|epoch>] [--json]

Agent-to-agent messages from the last 5 minutes (or --since 10m, 2h, 1d), newest
first: time, from, to, kind and a plain summary of at most 100 characters.
--before keeps only messages received strictly before its cutoff, so --since and
--before read one closed [since, before) window. No message text beyond that
summary is shown. --json prints bus.recent.v1
{schema, as_of, messages:[{at, from, to, kind, summary}]}; messages is null when
the bus could not be read. Read only.`;

export async function cmdBusRecent(args: string[], out: (text: string) => void = console.log,
  err: (text: string) => void = console.error): Promise<number> {
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(BUS_RECENT_USAGE); return 0; }
  let json = false, since: string | undefined, before: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--since' && since === undefined && value !== undefined) { since = value; i++; }
    else if (arg === '--before' && before === undefined && value !== undefined) { before = value; i++; }
    else { err(BUS_RECENT_USAGE); return 2; }
  }
  const { formatBusRecentText, readBusRecent } = await import('../core/fleet/bus-recent.js');
  const read = readBusRecent({ since, before });
  if (!read.ok) { err(read.error); return 2; }
  out(json ? JSON.stringify(read.result, null, 2) : formatBusRecentText(read.result));
  return read.result.messages === null ? 1 : 0;
}
