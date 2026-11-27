/**
 * Shared keep-alive machinery for `phm node <verb> --watch [--every <seconds>]`
 * (beat, renew): repeat the ordinary verb on an interval until a non-zero exit
 * or the stop signal. The watch flags are consumed here and never forwarded,
 * so the fleet flag table and the pool wire protocol are unchanged — an older
 * primary or store parser never sees them.
 */
import { setTimeout as delay } from 'node:timers/promises';

const NODE_WATCH_DEFAULT_SECONDS = 10;
/** Sessions and claims expire 30 s after the last beat/renew; the interval stays well inside that. */
const NODE_WATCH_MAX_SECONDS = 25;
/** Sub-second passes would spin the store's fsync'd transactions for no lease benefit. */
const NODE_WATCH_MIN_SECONDS = 1;

export interface NodeWatchFlags {
  /** Verb arguments with --watch/--every removed; everything else passes through verbatim. */
  base: string[];
  everyMs: number;
  everySeconds: number;
}

function everySeconds(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds >= NODE_WATCH_MIN_SECONDS && seconds <= NODE_WATCH_MAX_SECONDS ? seconds : null;
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
      if (seconds === null) return { error: `--every must be a number of seconds at least ${NODE_WATCH_MIN_SECONDS} and at most ${NODE_WATCH_MAX_SECONDS}.` };
      every = seconds;
      continue;
    }
    base.push(arg);
  }
  const seconds = every ?? NODE_WATCH_DEFAULT_SECONDS;
  return { base, everyMs: Math.round(seconds * 1000), everySeconds: seconds };
}

interface NodeWatchLoopDeps {
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

interface NodeWatchLoopOptions extends NodeWatchLoopDeps {
  /** Envelope `command` field on the stop line ('beat', 'renew'). */
  command: string;
  flags: NodeWatchFlags;
  /** Plain-text line printed when the loop stops on a signal. */
  stoppedText: string;
}

export interface NodeWatchCommandDeps {
  /** One pass; defaults to the verb's normal dispatch (pool-aware). */
  run?: (args: string[]) => Promise<number>;
  /** Injectable for tests; production waits on a timer the stop signal can cut short. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Test seam: an aborted signal stops the loop exactly like SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

export interface NodeWatchCommandOptions {
  command: string;
  args: string[];
  stoppedText: string;
  deps: NodeWatchCommandDeps;
  defaultRun: (args: string[]) => Promise<number>;
  argsFor?: (base: string[]) => string[];
}

/** Parse watch flags, report usage errors in the standard envelope, then run the watch loop. */
export async function runNodeWatchCommand(opts: NodeWatchCommandOptions): Promise<number> {
  const json = opts.args.includes('--json');
  const log = opts.deps.log ?? ((line: string) => console.log(line));
  const errorOut = opts.deps.error ?? ((line: string) => console.error(line));
  const parsed = parseNodeWatchFlags(opts.args);
  if ('error' in parsed) {
    const fix = `Run: phm node ${opts.command} --help`;
    if (json) {
      log(JSON.stringify({ schemaVersion: 1, command: opts.command, error: { code: 'usage', message: parsed.error, fix } }));
    } else errorOut(`${parsed.error} Fix: ${fix}`);
    return 2;
  }
  return runNodeWatchLoop({
    command: opts.command,
    flags: parsed,
    stoppedText: opts.stoppedText,
    run: opts.deps.run ?? opts.defaultRun,
    argsFor: opts.argsFor,
    sleep: opts.deps.sleep,
    signal: opts.deps.signal,
    log,
  });
}

/** Repeat the ordinary verb on the watch interval until a non-zero exit or the stop signal. */
async function runNodeWatchLoop(opts: NodeWatchLoopOptions): Promise<number> {
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
