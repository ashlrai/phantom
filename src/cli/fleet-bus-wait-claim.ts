import { validBusWaitClaimRequest, waitClaimBusWork, type BusWaitClaimRequest } from '../core/fleet/bus-wait-claim.js';

/** Waits for one real claim; message bodies are never executed. */
export async function cmdFleetBusWaitClaim(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet bus-wait-claim --to <exact-address> --owner <label> --lease-ms <1..3600000> --wait-ms <1..300000> [--root <absolute>] --json\nLocal coordination only; labels are not identity or authority.');
    return 0;
  }
  const values = new Map<string, string>();
  let json = false, invalid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--to', '--owner', '--lease-ms', '--wait-ms', '--root'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const number = (key: string) => { const s = values.get(key); return s && /^\d+(?![\s\S])/.test(s) ? Number(s) : NaN; };
  const request: BusWaitClaimRequest = { to: values.get('--to')!, owner: values.get('--owner')!, root: values.get('--root'), leaseMs: number('--lease-ms'), waitMs: number('--wait-ms') };
  if (invalid || !json || !validBusWaitClaimRequest(request)) {
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
