import { claimNextBusWork } from '../core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim, type BusClaimRequest } from '../core/fleet/bus-work-claims.js';

export const COMMS_BUS_CLAIM_HELP = `phm comms bus next --to <address|topic> --owner <label> --lease-ms <1..3600000>
phm comms bus claim acquire --id <message-id> --owner <label> --lease-ms <1..3600000>
phm comms bus claim renew|release|complete --id <message-id> --token <claim-token>
Leases make one claimant per message ID: a live lease answers 'conflict' to everyone else.
next claims the oldest highest-priority live task (protocol kind 'task' or legacy {kind:'work'})
addressed to --to, which may be a topic name. Exit 0 acquired or empty, 1 unavailable/retryable,
2 invalid. Claim output includes the token; never log it. Renew reuses the original lease length.
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
    const values = flagValues(args, ['--to', '--owner', LEASE_FLAG]);
    const to = values?.get('--to'), owner = values?.get('--owner'), lease = leaseMs(values?.get(LEASE_FLAG));
    if (!values || to === undefined || owner === undefined || lease === undefined) return invalid();
    const result = claimNextBusWork({ to, owner, leaseMs: lease, root });
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
