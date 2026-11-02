import { mutateBusWorkClaim, validBusClaimRequest, type BusClaimRequest } from '../core/fleet/bus-work-claims.js';

/** Coordination handles only; never authenticates a worker or executes a task. */
export async function cmdFleetBusClaim(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet bus-claim acquire --id <message> --owner <label> --lease-ms <1..3600000> [--root <absolute>] [--json]\nrenew|release|complete --id <message> --token <claim-token> [--root <absolute>] [--json]\nLocal coordination only; no identity or execution authority. Renew reuses the original lease duration.');
    return 0;
  }
  const values = new Map<string, string>();
  let json = false, invalid = false;
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--id', '--owner', '--lease-ms', '--token', '--root'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const lease = values.get('--lease-ms');
  const request: BusClaimRequest = { action: args[0] as BusClaimRequest['action'], id: values.get('--id')!,
    owner: values.get('--owner'), token: values.get('--token'), root: values.get('--root'),
    leaseMs: lease === undefined ? undefined : /^\d+(?![\s\S])/.test(lease) ? Number(lease) : NaN };
  const result = invalid || !validBusClaimRequest(request) ? { status: 'invalid' } : mutateBusWorkClaim(request);
  try { console.log(JSON.stringify(result)); } catch { return 1; }
  return ['acquired', 'renewed', 'released'].includes(result.status) ||
    (result.status === 'completed' && request.action === 'complete' && 'leaseUntil' in result) ? 0 : result.status === 'invalid' ? 2 : 1;
}
