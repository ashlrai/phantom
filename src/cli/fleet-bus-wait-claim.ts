import { validBusWaitClaimRequest, waitClaimBusWork, type BusWaitClaimRequest } from '../core/fleet/bus-wait-claim.js';
import { BUS_PRIORITIES } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

const usage = `Usage: ashlr fleet bus-wait-claim --to <exact-address> --owner <label> --lease-ms <1..3600000> --wait-ms <1..300000> [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority <P0|P1|P2|P3>] [--channel <name>] [--topic <topic>] [--from <agent>] [--exclude-from <agent>] [--root <absolute>] --json
Local coordination only; labels are not identity or authority.
--to matches work under every label of a registered agent identity and group:<channel>:<topic> addresses of channels it belongs to, minus its own channel posts; an unresolvable --to or unreadable registry keeps exact-label matching. --contains keeps only receipts whose scrubbed one-line summary carries the text, --since only receipts received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time), --before only receipts received strictly before its own cutoff so the two compose one [since, before) window, --priority only one P0..P3 band, --channel only receipts addressed to group:<name>:* of one bus channel, --topic only receipts addressed to a well-formed group:<room>:<topic> address carrying that exact topic — composing with --channel into one room and one topic — --from only receipts one sender wrote and --exclude-from drops receipts sent under every registered spelling of one identity — the same rules every bus read applies, so the wait claims exactly what the matching read would list.`;

/** Waits for one real claim; message bodies are never executed. */
export async function cmdFleetBusWaitClaim(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const values = new Map<string, string>();
  let json = false, invalid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--to', '--owner', '--lease-ms', '--wait-ms', '--root', '--contains', '--since', '--before', '--priority', '--channel', '--topic', '--from', '--exclude-from'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const number = (key: string) => { const s = values.get(key); return s && /^\d+(?![\s\S])/.test(s) ? Number(s) : NaN; };
  const sinceRaw = values.get('--since');
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
  const beforeRaw = values.get('--before');
  const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw);
  const priority = values.get('--priority');
  const request: BusWaitClaimRequest = { to: values.get('--to')!, owner: values.get('--owner')!, root: values.get('--root'), leaseMs: number('--lease-ms'), waitMs: number('--wait-ms'),
    contains: values.get('--contains'), since: since ?? undefined, before: before ?? undefined,
    priority: priority as (typeof BUS_PRIORITIES)[number] | undefined,
    channel: values.get('--channel'), topic: values.get('--topic'), from: values.get('--from'), excludeFrom: values.get('--exclude-from') };
  if (invalid || !json || (sinceRaw !== undefined && since === null) ||
    (beforeRaw !== undefined && before === null) ||
    (priority !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(priority)) ||
    !validBusWaitClaimRequest(request)) {
    console.log(JSON.stringify({ status: 'invalid' }));
    return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const result = await waitClaimBusWork(request, controller.signal);
    console.log(JSON.stringify(result));
    return result.status === 'acquired' ? 0 : result.status === 'invalid' ? 2 : 1;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}
