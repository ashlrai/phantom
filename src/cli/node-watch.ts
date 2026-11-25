/**
 * Shared keep-alive machinery for `phm node <verb> --watch [--every <seconds>]`
 * (beat, renew): repeat the ordinary verb on an interval until a non-zero exit
 * or the stop signal. The watch flags are consumed here and never forwarded,
 * so the fleet flag table and the pool wire protocol are unchanged — an older
 * primary or store parser never sees them.
 */
import { setTimeout as delay } from 'node:timers/promises';

export const NODE_WATCH_DEFAULT_SECONDS = 10;
/** Sessions and claims expire 30 s after the last beat/renew; the interval stays well inside that. */
export const NODE_WATCH_MAX_SECONDS = 25;

export interface NodeWatchFlags {
  /** Verb arguments with --watch/--every removed; everything else passes through verbatim. */
  base: string[];
  everyMs: number;
  everySeconds: number;
}

function everySeconds(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds > 0 && seconds <= NODE_WATCH_MAX_SECONDS ? seconds : null;
}

/** --watch and --every are dispatcher flags: they are stripped here and never reach the verb parser. */
export function parseNodeWatchFlags(args: string[]): NodeWatchFlags | { error: string } {
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
      if (seconds === null) return { error: `--every must be a number of seconds above 0 and at most ${NODE_WATCH_MAX_SECONDS}.` };
      every = seconds;
      continue;
    }
    base.push(arg);
  }
  const seconds = every ?? NODE_WATCH_DEFAULT_SECONDS;
  return { base, everyMs: Math.round(seconds * 1000), everySeconds: seconds };
}

export interface NodeWatchLoopDeps {
  /** One verb pass; the caller supplies the dispatch (pool-aware where it matters). */
  run: (args: string[]) => Promise<number>;
  /** Per-pass arguments, called each pass; defaults to the caller's base flags verbatim. */
  argsFor?: (base: string[]) => string[];
  /** Injectable for tests; production waits on a timer the stop signal can cut short. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test seam: an aborted signal stops the loop exactly like SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

export interface NodeWatchLoopOptions extends NodeWatchLoopDeps {
  /** Envelope `command` field on the stop line ('beat', 'renew'). */
  command: string;
  flags: NodeWatchFlags;
  /** Plain-text line printed when the loop stops on a signal. */
  stoppedText: string;
}

/** Repeat the ordinary verb on the watch interval until a non-zero exit or the stop signal. */
export async function runNodeWatchLoop(opts: NodeWatchLoopOptions): Promise<number> {
  const json = opts.flags.base.includes('--json');
  const log = opts.log ?? ((line: string) => console.log(line));
  const ac = new AbortController();
  const stop = () => ac.abort();
  const signal = opts.signal ?? ac.signal;
  if (!opts.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  const pause = opts.sleep ?? ((ms: number) => delay(ms, undefined, { signal }).then(() => undefined, () => undefined));
  try {
    for (;;) {
      if (signal.aborted) break;
      const code = await opts.run(opts.argsFor ? opts.argsFor(opts.flags.base) : opts.flags.base);
      if (code !== 0) return code;
      await pause(opts.flags.everyMs);
    }
  } finally {
    if (!opts.signal) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  if (json) log(JSON.stringify({ schemaVersion: 1, command: opts.command, watch: { stopped: 'signal', everySeconds: opts.flags.everySeconds } }));
  else log(opts.stoppedText);
  return 0;
}
