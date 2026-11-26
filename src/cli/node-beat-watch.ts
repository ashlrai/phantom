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
  /** Session-expired recovery: return the session to beat with next (a fresh
   * rejoin or an adopted live one), or null to stop the watch. Production
   * wires the standalone registry's last-profile rejoin; a pool Mac passes
   * nothing because its sessions live on the primary's witness. */
  rejoin?: (nodeId: string) => Promise<number | null>;
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

/** The production session-expired recovery for a standalone watch: undefined
 * on a pool Mac — its sessions live on the primary's witness, not this store —
 * or when the hook cannot be built. Everything else delegates to the fleet
 * layer's last-profile rejoin against this machine's own registry. */
async function defaultSessionRejoin(): Promise<NodeBeatWatchDeps['rejoin']> {
  try {
    const { hasNodePool } = await import('./node-pool.js');
    if (hasNodePool()) return undefined;
    const { rejoinStandaloneSession } = await import('./node-fleet.js');
    return nodeId => rejoinStandaloneSession(nodeId);
  } catch { return undefined; }
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
  // --session is rewritten per pass so a session-expired rejoin flows into the
  // next beat without restarting the watch; --node never changes on rejoin.
  const base: string[] = [];
  let nodeId: string | undefined;
  let session: number | undefined;
  let sessionSeen = false;
  for (let i = 0; i < parsed.base.length; i++) {
    const arg = parsed.base[i]!;
    // Only a well-formed session is lifted out for rewriting; anything else —
    // a bad value, or a second --session the beat parser must refuse as a
    // duplicate — stays in the args so the parser names it.
    if (!sessionSeen && arg === '--session') {
      const value = parsed.base[i + 1];
      if (value !== undefined && /^\d+$/.test(value)) { session = Number(value); sessionSeen = true; i++; continue; }
      base.push(arg);
      continue;
    }
    if (!sessionSeen && arg.startsWith('--session=')) {
      const value = arg.slice('--session='.length);
      if (/^\d+$/.test(value)) { session = Number(value); sessionSeen = true; continue; }
      base.push(arg);
      continue;
    }
    if (arg === '--node') nodeId = parsed.base[i + 1];
    else if (arg.startsWith('--node=')) nodeId = arg.slice('--node='.length);
    base.push(arg);
  }
  const beatBase = () => [...base, ...(session === undefined ? [] : ['--session', String(session)])];
  const rejoin = deps.rejoin ?? await defaultSessionRejoin();
  return runNodeWatchLoop({
    command: 'beat',
    flags: parsed,
    stoppedText: 'Heartbeat stopped; the node session expires on its own within 30 seconds.',
    run: deps.run ?? (async (beat: string[]) => (await import('./node-fleet.js')).cmdNodeFleet('beat', beat)),
    argsFor: () => beatArgs(beatBase(), deps),
    recover: rejoin !== undefined && nodeId !== undefined ? async (code: number) => {
      // Only an operational failure can be a dead session; usage errors (2)
      // and a still-live session's other exit-1 failures keep their exit.
      if (code !== 1 || session === undefined) return false;
      const next = await rejoin(nodeId);
      // The same session back means the beat failed for another reason; a
      // new or adopted session means the keep-alive can carry on.
      if (next === null || next === session) return false;
      session = next;
      if (json) log(JSON.stringify({ schemaVersion: 1, command: 'beat', watch: { rejoined: nodeId, session: next } }));
      else log(`Session expired; rejoined ${nodeId} as session ${next}.`);
      return true;
    } : undefined,
    sleep: deps.sleep,
    signal: deps.signal,
    log,
  });
}
