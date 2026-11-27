/**
 * `phm node beat --watch [--every <seconds>]`: keep this node's session alive by
 * repeating the ordinary beat on an interval. Each pass is exactly one
 * `phm node beat` through the normal dispatch, so a pooled Mac still reaches the
 * primary through the usual delegation and every refusal keeps its error
 * envelope. The watch flags are consumed here and never forwarded, so an older
 * primary or store parser never sees them.
 *
 * Capacity and host stats are re-measured on this machine each pass unless the
 * caller passed those flags explicitly — the same fresh samples the pool worker
 * reports — while usage and auth are never invented: an unreported node stays
 * unknown. A held or unmeasurable sample is simply omitted that pass; a hold the
 * sample schema cannot express (cpu-*, host-slots-*) still advertises --slots 0,
 * the same zero bound the pool worker sends, so the node holds admission instead
 * of keeping its last reported slots or reading unbounded.
 */
import { readNodeCapacity, sampleHostStats, type NodeCapacity } from '../core/drive/nodes/capacity.js';
import { nodeBeatCapacity } from '../core/drive/nodes/capacity-sample.js';
import { isHostStats, type HostStats } from '../core/drive/nodes/state.js';
import { parseNodeWatchFlags, runNodeWatchLoop } from './node-watch.js';

/** Same bound the pool worker applies to one host-stats sample. */
const HOST_STATS_MAX_BYTES = 64 * 1024;

export interface NodeBeatWatchDeps {
  /** One beat pass; defaults to the `phm node beat` dispatch (pool-aware). */
  run?: (args: string[]) => Promise<number>;
  measure?: () => NodeCapacity;
  hostStats?: () => HostStats;
  /** Injectable for tests; production waits on a timer the stop signal can cut short. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  host?: () => string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Test seam: an aborted signal stops the loop exactly like SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

function hasFlag(args: string[], name: string): boolean {
  return args.some(a => a === name || a.startsWith(`${name}=`));
}

/** One beat's arguments: the caller's flags plus a freshly measured capacity sample
 * and host stats, each only when the caller did not supply that flag. */
function beatArgs(base: string[], deps: NodeBeatWatchDeps): string[] {
  const args = [...base];
  if (!hasFlag(base, '--capacity')) {
    try {
      const report = nodeBeatCapacity((deps.measure ?? readNodeCapacity)(),
        { ...(deps.now ? { now: deps.now } : {}), ...(deps.host ? { host: deps.host } : {}) });
      if (report.sample) args.push('--capacity', JSON.stringify(report.sample));
      // The pool worker zeroes its advertised slots on every hold
      // (routerSlots in worker.ts); a standalone keep-alive must do the same for
      // the holds the sample cannot carry, or the node keeps its last bound —
      // or none — and the router keeps assigning it work it measured as held.
      // An explicit --slots still wins, and a measurement that throws stays
      // unknown rather than held.
      else if (report.omit === 'unreportable-held' && !hasFlag(base, '--slots')) args.push('--slots', '0');
    } catch { /* unmeasured capacity stays absent: the node reads unknown, never a guess */ }
  }
  if (!hasFlag(base, '--host-stats')) {
    try {
      const stats = (deps.hostStats ?? sampleHostStats)();
      const encoded = JSON.stringify(stats);
      if (isHostStats(stats) && encoded.length <= HOST_STATS_MAX_BYTES) args.push('--host-stats', encoded);
    } catch { /* host stats are advisory; a failed sample is simply not sent */ }
  }
  return args;
}

export async function cmdNodeBeatWatch(args: string[], deps: NodeBeatWatchDeps = {}): Promise<number> {
  const json = args.includes('--json');
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorOut = deps.error ?? ((line: string) => console.error(line));
  const parsed = parseNodeWatchFlags(args);
  if ('error' in parsed) {
    const fix = 'Run: phm node beat --help';
    if (json) {
      log(JSON.stringify({ schemaVersion: 1, command: 'beat', error: { code: 'usage', message: parsed.error, fix } }));
    } else errorOut(`${parsed.error} Fix: ${fix}`);
    return 2;
  }
  return runNodeWatchLoop({
    command: 'beat',
    flags: parsed,
    stoppedText: 'Heartbeat stopped; the node session expires on its own within 30 seconds.',
    run: deps.run ?? (async (beat: string[]) => (await import('./node-fleet.js')).cmdNodeFleet('beat', beat)),
    argsFor: base => beatArgs(base, deps),
    sleep: deps.sleep,
    signal: deps.signal,
    log,
  });
}
