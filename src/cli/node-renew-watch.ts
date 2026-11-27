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
import { runNodeWatchCommand, type NodeWatchCommandDeps } from './node-watch.js';

export type NodeRenewWatchDeps = NodeWatchCommandDeps;

export async function cmdNodeRenewWatch(args: string[], deps: NodeRenewWatchDeps = {}): Promise<number> {
  return runNodeWatchCommand({
    command: 'renew',
    args,
    deps,
    stoppedText: 'Claim watch stopped; the job lease expires on its own within 30 seconds and the job can be pulled again.',
    defaultRun: async (renew: string[]) => (await import('./node-fleet.js')).cmdNodeFleet('renew', renew),
  });
}
