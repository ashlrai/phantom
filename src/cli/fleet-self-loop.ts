/**
 * `ashlr fleet self-loop` — keeps the self-management pass running for a
 * bounded window with no desktop app and no external shell timer. Each pass
 * is the real cmdFleetSelfTick (reset-release → lane-autohold → planner-tick
 * under queue/self-tick.lock, person's holds never released); this command
 * adds only repetition: first pass immediately, each later pass one full
 * interval after the previous pass completes, never overlapping. Admission
 * stops at the deadline; a pass already running then finishes normally.
 * SIGINT/SIGTERM stop admission and interrupt the sleep — an in-flight pass
 * still finishes, then the summary is printed. Without --apply every pass is
 * a dry run: nothing is released, held or spawned. Unknown or duplicate
 * options are refused before any pass runs.
 *
 * --stream opts into live progress: one sanitized, size-bounded NDJSON line
 * ({v:1,record:'pass',…}) is emitted the moment each pass completes, then
 * exactly one distinguishable final line ({v:1,record:'summary',…}) when the
 * loop ends — a supervising agent never waits for the whole window. Memory
 * stays constant: lines are written and dropped, nothing is accumulated.
 * --stream and --json are mutually exclusive (--json keeps its single final
 * summary line) and the combination is rejected before any pass runs. If the
 * stream sink throws, admission stops safely, the signal handlers are still
 * removed, and the final summary names the failure (termination
 * 'observer-error', exit 1).
 *
 * --max-ticks <n> (integer 1..1000) is optional alongside --duration-ms:
 * whichever bound occurs first stops admission. When the count bound ends
 * the loop the summary carries termination 'max-ticks' and an optional
 * maxTicks count. Default behavior (no --max-ticks) is unchanged.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cmdFleetSelfTick } from './fleet-self-tick.js';
import type { RunSelfTickOptions, SelfTickSteps } from '../core/fleet/self-tick.js';
import type { SpawnLike } from '../core/fleet/planner-run.js';
import {
  runSelfLoop,
  SELF_LOOP_DEFAULT_INTERVAL_MS,
  SELF_LOOP_MAX_DURATION_MS,
  SELF_LOOP_MIN_INTERVAL_MS,
  type RunSelfLoopOptions,
  type SelfLoopPassEvent,
  type SelfLoopTick,
} from '../core/fleet/self-loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

/** Hard cap on any streamed NDJSON line. Export lets tests assert the bound. */
export const SELF_LOOP_STREAM_MAX_CHARS = 16_384;
/** Marks a report that exceeded the line budget and was replaced by a preview. */
const STREAM_TRUNCATION_MARK = '…[truncated]';

/**
 * Serialize one stream record as a single sanitized NDJSON line whose length
 * never exceeds SELF_LOOP_STREAM_MAX_CHARS. The only unbounded field is the
 * pass report (heavyKey); when the line would overflow, that field becomes a
 * bounded string preview of its sanitized serialization plus a marker, so
 * the line stays one valid JSON value either way.
 */
const toStreamLine = (record: Record<string, unknown>, heavyKey: 'report' | 'lastReport'): string => {
  const sanitized = sanitizePublicJson(record) as Record<string, unknown>;
  const line = JSON.stringify(sanitized);
  if (line.length <= SELF_LOOP_STREAM_MAX_CHARS) return line;
  const reportJson = JSON.stringify(sanitized[heavyKey] ?? null);
  const build = (take: number) => JSON.stringify({
    ...sanitized, [heavyKey]: reportJson.slice(0, take) + STREAM_TRUNCATION_MARK, reportTruncated: true,
  });
  // Re-escaping '"' and '\' can outgrow any static budget, so shrink until
  // the serialized line fits — the intake strictly decreases, so this ends.
  let take = reportJson.length;
  let out = build(take);
  while (out.length > SELF_LOOP_STREAM_MAX_CHARS && take > 0) {
    take = Math.max(0, take - (out.length - SELF_LOOP_STREAM_MAX_CHARS));
    out = build(take);
  }
  return out;
};

const usage = `Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--max-ticks <n>] [--failure-backoff-max-ms <ms>] [--busy-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream]
Repeat the self-management pass (fleet self-tick) for a bounded window:
first pass immediately, then one pass every interval (default 60000ms,
minimum 1000ms), never overlapping, until --duration-ms (maximum 24h) is
reached. The deadline only gates admission — a pass already running finishes
normally. SIGINT/SIGTERM stop admission and interrupt the wait without
killing a running pass; the summary prints either way. Each pass is the real
self-tick with its own queue/self-tick.lock: a contended pass counts 'busy'
and the loop continues, as does a failed pass. --failure-backoff-max-ms
opts into doubling the delay after consecutive failures, up to the given max
(between the interval and 24h); success or busy resets it. --busy-backoff-max-ms
opts into the same doubling for consecutive busy passes (any exit code), up to
the given max (between the interval and 24h); any other outcome resets only
that busy streak. With both enabled the longer current delay is used. Stream
pass records include consecutiveFailures, consecutiveBusy (when enabled) and
nextDelayMs (when either is enabled). --max-ticks <n> (integer 1..1000) is
optional alongside --duration-ms: whichever bound occurs first stops
admission. When the count bound ends the loop the summary carries
termination 'max-ticks' and an optional maxTicks count. --json prints one
final sanitized summary line (unchanged default shape). --stream instead
prints sanitized bounded NDJSON live: one {"v":1,"record":"pass",...} line
per completed pass, then exactly one {"v":1,"record":"summary",...} line.
--stream and --json are mutually exclusive and rejected before any pass
runs. Exit 0 when no pass failed, 1 when any did (or the stream sink did),
2 on usage.`;

interface Dependencies {
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Full tick override; without it each pass is the real cmdFleetSelfTick. */
  tick?: SelfLoopTick;
  /** Sleep seam; rejects on abort. Defaults to the core real-time sleep. */
  sleep?: RunSelfLoopOptions['sleep'];
  /** Per-step overrides forwarded to cmdFleetSelfTick; tests fake them. */
  steps?: Partial<SelfTickSteps>;
  /** Lock seam forwarded to cmdFleetSelfTick. */
  acquireLock?: RunSelfTickOptions['acquireLock'];
  /** planner-tick spawn seam; tests fake it, never a shell. */
  spawn?: SpawnLike;
  /** Signal seam; defaults to SIGINT+SIGTERM on this process. Returns the unregister. */
  onSignal?: (handler: () => void) => () => void;
}

export async function cmdFleetSelfLoop(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, apply = false, stream = false;
  let durationMs: number | undefined, intervalMs: number | undefined, runsDir: string | undefined;
  let failureBackoffMaxMs: number | undefined, busyBackoffMaxMs: number | undefined;
  let maxTicks: number | undefined;
  const parseMs = (value: string | undefined): number | undefined => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const parsePositiveInt = (value: string | undefined): number | undefined => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--stream' && !stream) stream = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--duration-ms' && durationMs === undefined) {
      durationMs = parseMs(args[++i]);
      if (durationMs === undefined || durationMs < 1 || durationMs > SELF_LOOP_MAX_DURATION_MS) return invalid();
    } else if (arg === '--interval-ms' && intervalMs === undefined) {
      intervalMs = parseMs(args[++i]);
      if (intervalMs === undefined || intervalMs < SELF_LOOP_MIN_INTERVAL_MS) return invalid();
    } else if (arg === '--max-ticks' && maxTicks === undefined) {
      const parsed = parsePositiveInt(args[++i]);
      if (parsed === undefined || parsed < 1 || parsed > 1000) return invalid();
      maxTicks = parsed;
    } else if (arg === '--failure-backoff-max-ms' && failureBackoffMaxMs === undefined) {
      failureBackoffMaxMs = parseMs(args[++i]);
      if (failureBackoffMaxMs === undefined || failureBackoffMaxMs > SELF_LOOP_MAX_DURATION_MS) return invalid();
    } else if (arg === '--busy-backoff-max-ms' && busyBackoffMaxMs === undefined) {
      busyBackoffMaxMs = parseMs(args[++i]);
      if (busyBackoffMaxMs === undefined || busyBackoffMaxMs > SELF_LOOP_MAX_DURATION_MS) return invalid();
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  // Compatibility is explicit: --stream IS the machine-readable mode, so
  // combining it with --json is a usage error, refused before any pass runs.
  if (stream && json) return invalid();
  if (durationMs === undefined) return invalid();
  if (failureBackoffMaxMs !== undefined && failureBackoffMaxMs < (intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS)) return invalid();
  if (busyBackoffMaxMs !== undefined && busyBackoffMaxMs < (intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS)) return invalid();
  // One root for the lock and all three steps of every pass, resolved here
  // once — same fallbacks as self-tick, so nothing can drift between passes.
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  const now = deps.now ?? Date.now;
  const realTick: SelfLoopTick = async () => {
    const captured: string[] = [];
    const exitCode = await cmdFleetSelfTick(
      ['--json', ...(apply ? ['--apply'] : []), '--runs-dir', root],
      {
        now,
        output: (text) => captured.push(text),
        error,
        ...(deps.steps === undefined ? {} : { steps: deps.steps }),
        ...(deps.acquireLock === undefined ? {} : { acquireLock: deps.acquireLock }),
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      },
    );
    // The tick's stdout stays captured; only its parsed report shapes the
    // single summary line this command prints.
    const text = captured.join('\n').trim();
    let report: unknown = null;
    if (text) { try { report = JSON.parse(text); } catch { report = null; } }
    return { exitCode, report };
  };
  const controller = new AbortController();
  const onSignal = deps.onSignal ?? ((handler: () => void) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.removeListener('SIGINT', handler);
      process.removeListener('SIGTERM', handler);
    };
  });
  // In --stream mode each completed pass is emitted as one sanitized bounded
  // NDJSON line the moment it finishes — the real tick path included — so a
  // supervisor sees progress while later passes are still deferred. A throw
  // from the sink ends admission safely inside runSelfLoop ('observer-error').
  const onPass = stream
    ? (event: SelfLoopPassEvent): void => {
      output(toStreamLine({
        v: 1, record: 'pass', pass: event.pass, exitCode: event.exitCode,
        state: event.state, report: event.report,
        ...(event.consecutiveFailures === undefined ? {} : { consecutiveFailures: event.consecutiveFailures }),
        ...(event.consecutiveBusy === undefined ? {} : { consecutiveBusy: event.consecutiveBusy }),
        ...(event.nextDelayMs === undefined ? {} : { nextDelayMs: event.nextDelayMs }),
      }, 'report'));
    }
    : undefined;
  const removeSignalListeners = onSignal(() => controller.abort());
  let summary;
  try {
    summary = await runSelfLoop({
      durationMs,
      maxTicks,
      intervalMs: intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS,
      ...(failureBackoffMaxMs === undefined ? {} : { failureBackoffMaxMs }),
      ...(busyBackoffMaxMs === undefined ? {} : { busyBackoffMaxMs }),
      tick: deps.tick ?? realTick,
      now,
      signal: controller.signal,
      ...(onPass === undefined ? {} : { onPass }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } finally {
    removeSignalListeners();
  }
  if (stream) {
    // Flattened so the unbounded lastReport sits at the record's top level,
    // where toStreamLine's size cap can reach it.
    output(toStreamLine({ ...summary, v: 1, record: 'summary' }, 'lastReport'));
  } else if (json) {
    output(JSON.stringify(sanitizePublicJson(summary)));
  } else {
    const label = summary.termination === 'observer-error' ? 'OBSERVER-ERROR'
      : summary.termination === 'max-ticks' ? 'MAX-TICKS'
        : summary.termination === 'interrupted' ? 'INTERRUPTED' : 'DONE';
    output(`fleet self-loop: ${label
    } — ticks=${summary.ticks} failed=${summary.failures} busy=${summary.busy} (${apply ? 'apply' : 'dry-run'})`);
  }
  return summary.failures > 0 || summary.observerError !== undefined ? 1 : 0;
}
