import { runBusWorkPool, validBusWorkPoolOptions, type BusWorkPoolOptions } from '../core/fleet/bus-work-pool.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = 'Usage: ashlr fleet bus-work-pool --to <address> --owner <label> --lease-ms <ms> --wait-ms <ms> --max-jobs <1..16> --concurrency <1..4> --snapshot <absolute> --prompt <absolute> [--root <absolute>] [--timeout-ms <1..3600000>] -- <program> [args...]';
const note = '--max-jobs is the total pool limit. Fixed quotas can remain unused after a worker fails; external effects are not exactly-once.';

export async function cmdFleetBusWorkPool(args: string[], io: ContextWorkerIO = {}): Promise<number> {
  const out = io.stdout ?? process.stdout, err = io.stderr ?? process.stderr;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { out.write(`${usage}\n${note}\n`); return 0; }
  const invalid = () => { err.write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--to', '--owner', '--lease-ms', '--wait-ms', '--max-jobs', '--concurrency', '--snapshot', '--prompt', '--root', '--timeout-ms'].includes(key) ||
      flags.has(key) || !value || value.startsWith('--') || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const number = (key: string) => { const s = flags.get(key); return s && /^\d+(?![\s\S])/.test(s) ? Number(s) : NaN; };
  const opts: BusWorkPoolOptions = { to: flags.get('--to')!, owner: flags.get('--owner')!, root: flags.get('--root'),
    leaseMs: number('--lease-ms'), waitMs: number('--wait-ms'), maxJobs: number('--max-jobs'), concurrency: number('--concurrency'),
    snapshot: flags.get('--snapshot')!, prompt: flags.get('--prompt')!, argv: args.slice(split + 1),
    ...(flags.has('--timeout-ms') ? { timeoutMs: number('--timeout-ms') } : {}) };
  if (!validBusWorkPoolOptions(opts)) return invalid();
  const result = await runBusWorkPool(opts);
  out.write(`${JSON.stringify(result)}\n`);
  return result.status === 'max-jobs' || result.status === 'timeout' ? 0 : result.status === 'invalid' ? 2 : 1;
}
