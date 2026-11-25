/**
 * `phm node renew --watch [--every <seconds>]`: keep one claimed job's lease
 * alive by repeating the ordinary renew on an interval — the claim-side
 * counterpart of `beat --watch`. A pull's lease expires 30 seconds after the
 * last renew, so work that takes minutes loses its claim mid-run unless
 * something keeps renewing; this loop is that something for a manual holder.
 * Each pass is exactly one `phm node renew` through the normal dispatch, so a
 * pooled member still reaches the primary through the usual delegation and
 * every refusal keeps its error envelope. The watch flags are consumed here and
 * never forwarded, so an older primary or store parser never sees them. A
 * refused renew — a lost lease or dead session — stops the watch at once with
 * that error, and Ctrl-C lets the claim expire on its own so the job can be
 * pulled again.
 */
import { parseNodeWatchFlags, runNodeWatchLoop } from './node-watch.js';

export interface NodeRenewWatchDeps {
  /** One renew pass; defaults to the `phm node renew` dispatch (pool-aware). */
  run?: (args: string[]) => Promise<number>;
  /** Injectable for tests; production waits on a timer the stop signal can cut short. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Test seam: an aborted signal stops the loop exactly like SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

export async function cmdNodeRenewWatch(args: string[], deps: NodeRenewWatchDeps = {}): Promise<number> {
  const json = args.includes('--json');
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorOut = deps.error ?? ((line: string) => console.error(line));
  const parsed = parseNodeWatchFlags(args);
  if ('error' in parsed) {
    const fix = 'Run: phm node renew --help';
    if (json) {
      log(JSON.stringify({ schemaVersion: 1, command: 'renew', error: { code: 'usage', message: parsed.error, fix } }));
    } else errorOut(`${parsed.error} Fix: ${fix}`);
    return 2;
  }
  return runNodeWatchLoop({
    command: 'renew',
    flags: parsed,
    stoppedText: 'Claim watch stopped; the job lease expires on its own within 30 seconds and the job can be pulled again.',
    run: deps.run ?? (async (renew: string[]) => (await import('./node-fleet.js')).cmdNodeFleet('renew', renew)),
    sleep: deps.sleep,
    signal: deps.signal,
    log,
  });
}
