import { claimNextBusWork } from '../core/fleet/bus-next-claim.js';

/** Claims one opted-in receipt; never interprets or executes its body. */
export async function cmdFleetBusNext(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: ashlr fleet bus-next --to <exact-address> --owner <label> --lease-ms <1..3600000> [--root <absolute>] --json\nOnly messages addressed exactly to --to with an object body containing {"kind":"work"} are eligible. Local coordination only; labels are not identity or authority, and message bodies are never executed.');
    return 0;
  }
  const values = new Map<string, string>();
  let json = false, invalid = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--to', '--owner', '--lease-ms', '--root'].includes(key) || values.has(key)) { invalid = true; break; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { invalid = true; break; }
    values.set(key, value);
  }
  const lease = values.get('--lease-ms');
  const result = invalid || !json ? { status: 'invalid' } : claimNextBusWork({
    to: values.get('--to')!, owner: values.get('--owner')!, root: values.get('--root'),
    leaseMs: lease !== undefined && /^\d+(?![\s\S])/.test(lease) ? Number(lease) : NaN,
  });
  try { console.log(JSON.stringify(result)); } catch { return 1; }
  return result.status === 'acquired' || result.status === 'empty' ? 0 : result.status === 'invalid' ? 2 : 1;
}
