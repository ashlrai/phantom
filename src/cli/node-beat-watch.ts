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
 * unknown. A held or unmeasurable sample is simply omitted that pass.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { readNodeCapacity, sampleHostStats, type NodeCapacity } from '../core/drive/nodes/capacity.js';
import { nodeBeatCapacity } from '../core/drive/nodes/capacity-sample.js';
import { isHostStats, type HostStats } from '../core/drive/nodes/state.js';

const DEFAULT_EVERY_SECONDS = 10;
/** Node sessions expire 30 s after the last beat; the interval stays well inside that. */
const MAX_EVERY_SECONDS = 25;
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

interface WatchFlags {
  /** Beat arguments with --watch/--every removed; everything else passes through verbatim. */
  base: string[];
  everyMs: number;
  everySeconds: number;
}

function everySeconds(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds > 0 && seconds <= MAX_EVERY_SECONDS ? seconds : null;
}

/** --watch and --every are dispatcher flags: they are stripped here and never reach the beat parser. */
function parseWatchFlags(args: string[]): WatchFlags | { error: string } {
  const base: string[] = [];
  let every: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--watch') continue;
    if (arg === '--every' || arg.startsWith('--every=')) {
      const inline = arg === '--every' ? undefined : arg.slice('--every='.length);
      const raw = inline ?? args[++i];
      if (raw === undefined || raw.startsWith('--')) return { error: '--every needs a number of seconds.' };
      if (every !== undefined) return { error: '--every was given more than once.' };
      const seconds = everySeconds(raw);
      if (seconds === null) return { error: `--every must be a number of seconds above 0 and at most ${MAX_EVERY_SECONDS}.` };
      every = seconds;
      continue;
    }
    base.push(arg);
  }
  const seconds = every ?? DEFAULT_EVERY_SECONDS;
  return { base, everyMs: Math.round(seconds * 1000), everySeconds: seconds };
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
  const parsed = parseWatchFlags(args);
  if ('error' in parsed) {
    const fix = 'Run: phm node beat --help';
    if (json) {
      log(JSON.stringify({ schemaVersion: 1, command: 'beat', error: { code: 'usage', message: parsed.error, fix } }));
    } else errorOut(`${parsed.error} Fix: ${fix}`);
    return 2;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  const signal = deps.signal ?? ac.signal;
  if (!deps.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  const run = deps.run ?? (async (beat: string[]) => (await import('./node-fleet.js')).cmdNodeFleet('beat', beat));
  const pause = deps.sleep ?? ((ms: number) => delay(ms, undefined, { signal }).then(() => undefined, () => undefined));
  try {
    for (;;) {
      if (signal.aborted) break;
      const code = await run(beatArgs(parsed.base, deps));
      if (code !== 0) return code;
      await pause(parsed.everyMs);
    }
  } finally {
    if (!deps.signal) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  if (json) log(JSON.stringify({ schemaVersion: 1, command: 'beat', watch: { stopped: 'signal', everySeconds: parsed.everySeconds } }));
  else log(`Heartbeat stopped; the node session expires on its own within 30 seconds.`);
  return 0;
}
