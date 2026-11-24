import { claimNextBusWork } from '../core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim, type BusClaimRequest } from '../core/fleet/bus-work-claims.js';
import { BUS_PRIORITIES } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

export const COMMS_BUS_CLAIM_HELP = `phm comms bus next --to <address|topic> --owner <label> --lease-ms <1..3600000> [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority <P0|P1|P2|P3>] [--channel <name>] [--from <agent>] [--exclude-from <agent>]
phm comms bus claim acquire --id <message-id> --owner <label> --lease-ms <1..3600000>
phm comms bus claim renew|release|complete --id <message-id> --token <claim-token>
Leases make one claimant per message ID: a live lease answers 'conflict' to everyone else.
next claims the oldest highest-priority live task (protocol kind 'task' or legacy {kind:'work'})
addressed to --to. --to may be a topic name or any label of one agent identity — handle,
agent:<handle>, stable id or alias — or a group:<channel>:<topic> address of a channel the
identity belongs to (minus its own channel posts), resolved through the identity registry;
an unresolvable --to or unreadable registry keeps exact-label matching. --contains keeps only
receipts whose scrubbed one-line summary carries the text, --since only receipts received at or
after the cutoff (15m, 2h, 1d, epoch ms or an ISO time), --before only receipts received strictly
before its own cutoff so the two compose one [since, before) window, --priority only one
P0..P3 band, --channel only receipts addressed to group:<name>:* of one bus channel,
--from only receipts one sender wrote and --exclude-from drops receipts sent under
every registered spelling of one identity —
the same rules every bus read applies, so the claimable set is exactly what the matching read
would list; empty's {candidates, held} totals count only the filtered scan. Exit 0 acquired or
empty, 1
unavailable/retryable, 2 invalid. An empty result still reports {candidates, held}: the live
claimable receipts the scan found addressed to --to and how many answered conflict, so a dry
well (candidates 0) reads differently from held work. Claim output includes the token; never log it. Renew
reuses the original lease length.
Coordination only: a claim confers no authenticated identity and executes nothing.`;

const LEASE_FLAG = '--lease-ms';
const CLAIM_ACTIONS = ['acquire', 'renew', 'release', 'complete'] as const;
const CLAIM_OK = ['acquired', 'renewed', 'released', 'completed'];

/** Parses `--flag value` pairs from the allowed set; flag-like values need `--flag=value`, which this rejects. */
function flagValues(args: string[], allowed: readonly string[]): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!, value = args[++i];
    if (!allowed.includes(key) || values.has(key) || value === undefined || value.startsWith('--')) return undefined;
    values.set(key, value);
  }
  return values;
}

function leaseMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

/** Thin handler for `comms bus next` and `comms bus claim`; all lease logic lives in core. */
export function cmdCommsBusClaim(verb: 'next' | 'claim', args: string[], root: string | undefined): number {
  const invalid = (): number => { console.log(JSON.stringify({ status: 'invalid' })); return 2; };
  if (verb === 'next') {
    const values = flagValues(args, ['--to', '--owner', LEASE_FLAG, '--contains', '--since', '--before', '--priority', '--channel', '--from', '--exclude-from']);
    const to = values?.get('--to'), owner = values?.get('--owner'), lease = leaseMs(values?.get(LEASE_FLAG));
    const sinceRaw = values?.get('--since');
    const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
    const beforeRaw = values?.get('--before');
    const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw);
    const priority = values?.get('--priority');
    if (!values || to === undefined || owner === undefined || lease === undefined ||
        (sinceRaw !== undefined && since === null) ||
        (beforeRaw !== undefined && before === null) ||
        (priority !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(priority))) return invalid();
    const result = claimNextBusWork({ to, owner, leaseMs: lease, root,
      contains: values.get('--contains'), since: since ?? undefined, before: before ?? undefined,
      priority: priority as (typeof BUS_PRIORITIES)[number] | undefined,
      channel: values.get('--channel'), from: values.get('--from'), excludeFrom: values.get('--exclude-from') });
    console.log(JSON.stringify(result));
    return result.status === 'acquired' || result.status === 'empty' ? 0 : result.status === 'invalid' ? 2 : 1;
  }
  const [action, ...rest] = args;
  if (!(CLAIM_ACTIONS as readonly string[]).includes(action!)) return invalid();
  const acquire = action === 'acquire';
  const values = flagValues(rest, acquire ? ['--id', '--owner', LEASE_FLAG] : ['--id', '--token']);
  if (!values || values.get('--id') === undefined) return invalid();
  const lease = leaseMs(values.get(LEASE_FLAG));
  const request: BusClaimRequest = { action: action as BusClaimRequest['action'], id: values.get('--id')!, root,
    ...(acquire ? { owner: values.get('--owner'), leaseMs: lease } : { token: values.get('--token') }) };
  const result = mutateBusWorkClaim(request);
  console.log(JSON.stringify(result));
  return CLAIM_OK.includes(result.status) ? 0 : result.status === 'invalid' ? 2 : 1;
}
