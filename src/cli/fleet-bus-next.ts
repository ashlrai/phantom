import { claimNextBusWork } from '../core/fleet/bus-next-claim.js';
import { BUS_PRIORITIES } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

const usage = `Usage: ashlr fleet bus-next --to <agent-or-topic> --owner <label> --lease-ms <1..3600000> [--contains <text>] [--since <15m|2h|1d|ISO>] [--priority <P0|P1|P2|P3>] [--root <absolute>] --json
Messages with an object body containing {"kind":"work"} or protocol kind 'task' addressed to --to are eligible; when --to names a registered agent identity, work addressed under any of its labels (handle, agent: address, stable id, aliases) or to a group:<channel>:<topic> address of a channel it belongs to — minus its own channel posts — qualifies. --contains keeps only receipts whose scrubbed one-line summary carries the text, --since only receipts received at or after the cutoff (15m, 2h, 1d, epoch ms or an ISO time), and --priority only one P0..P3 band — the same rules every bus read applies, so the claimable set is exactly what the matching read would list. An empty result reports {candidates, held}: live claimable receipts the filtered scan found and how many answered conflict, distinguishing a dry well from held work. Local coordination only; labels are not identity or authority, and message bodies are never executed.`;

/** Claims one opted-in receipt; never interprets or executes its body. */
export async function cmdFleetBusNext(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  const values = new Map<string, string>();
  let json = false, invalid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--to', '--owner', '--lease-ms', '--root', '--contains', '--since', '--priority'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const lease = values.get('--lease-ms');
  const sinceRaw = values.get('--since');
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
  const priority = values.get('--priority');
  const result = invalid || !json || (sinceRaw !== undefined && since === null) ||
    (priority !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(priority)) ? { status: 'invalid' } : claimNextBusWork({
    to: values.get('--to')!, owner: values.get('--owner')!, root: values.get('--root'),
    leaseMs: lease !== undefined && /^\d+(?![\s\S])/.test(lease) ? Number(lease) : NaN,
    contains: values.get('--contains'), since: since ?? undefined,
    priority: priority as (typeof BUS_PRIORITIES)[number] | undefined,
  });
  try { console.log(JSON.stringify(result)); } catch { return 1; }
  return result.status === 'acquired' || result.status === 'empty' ? 0 : result.status === 'invalid' ? 2 : 1;
}
