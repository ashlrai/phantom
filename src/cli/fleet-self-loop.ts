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
 * --bus-to <label> --bus-root <abs-path> --bus-run-id <token> (one required
 * group): after each completed pass, post a compact progress envelope to the
 * existing durable bus transport (appendBusInbox).  No second bus is
 * implemented; posting uses the real transport so the bus file is
 * readable through listBusInboxAfter.  The body contains kind, run-id,
 * pass, exit-code, state, consecutiveFailures, nextDelayMs — never raw
 * reports, observer exceptions, or local paths.  An accepted duplicate
 * counts as delivery; any other post result ends admission via
 * observer-error semantics without re-running the tick, and produces
 * nonzero exit.  Opt-in only: without the group, the bus is untouched.
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
  type SelfLoopPassEvent,
  type SelfLoopTick,
} from '../core/fleet/self-loop.js';
import {
  parseBusConfigGroup,
  buildProgressEnvelope,
  postProgressEnvelope,
  type SelfLoopBusConfig,
} from '../core/fleet/self-loop-bus-progress.js';
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

const USAGE_TEXT = [
  'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>]',
  '  [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply]',
  '  [--json | --stream]',
  '  [--bus-to <label> --bus-root <abs> --bus-run-id <token>]',
  '',
  'Repeat the self-management pass (fleet self-tick) for a bounded window:',
  'first pass immediately, then one pass every interval (default 60000ms,',
  'minimum 1000ms), never overlapping, until --duration-ms (maximum 24h) is',
  'reached. The deadline only gates admission — a pass already running finishes',
  'normally. SIGINT/SIGTERM stop admission and interrupt the wait without',
  'killing a running pass; the summary prints either way. Each pass is the real',
  'self-tick with its own queue/self-tick.lock: a contended pass counts \'busy\'',
  'and the loop continues, as does a failed pass. --failure-backoff-max-ms',
  'opts into doubling the delay after consecutive failures, up to the given max',
  '(between the interval and 24h); success or busy resets it. Stream pass records',
  'include consecutiveFailures and nextDelayMs when enabled. --json prints one final',
  'sanitized summary line (unchanged default shape). --stream instead prints',
  'sanitized bounded NDJSON live: one {"v":1,"record":"pass",...} line per',
  'completed pass, then exactly one {"v":1,"record":"summary",...} line.',
  '--stream and --json are mutually exclusive and rejected before any pass',
  'runs. --bus-to/--bus-root/--bus-run-id post a compact progress envelope (kind,',
  'run-id, pass, exit-code, state, consecutiveFailures, nextDelayMs) to the',
  'existing durable bus after each pass; all three flags are required together,',
  'otherwise the bus is untouched. Ticks remain dry-run unless --apply.',
  'Exit 0 when no pass failed, 1 when any did (or the stream/bus posted',
  'a non-posted outcome).',
].join('\n');

function printUsageAndExit(output: (text: string) => void): number {
  output(USAGE_TEXT);
  return 0;
}

function reportUsageError(
  error: (text: string) => void,
  reason: string,
): number {
  error(`fleet self-loop: error: ${reason}`);
  return 2;
}

export async function cmdFleetSelfLoop(
  args: string[],
  deps: RunSelfTickOptions & {
    output?: (text: string) => void;
    error?: (text: string) => void;
    tick?: SelfLoopTick;
    onSignal?: (handler: () => void) => () => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    steps?: SelfTickSteps;
    acquireLock?: typeof import('../core/fleet/local-store-lock.js').acquireLocalStoreLockWithOutcome;
    spawn?: SpawnLike;
  } = {} as RunSelfTickOptions,
): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const parseMs = (value: string): number | undefined => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  let json = false, stream = false, apply = false;
  let durationMs: number | undefined;
  let intervalMs: number | undefined;
  let failureBackoffMaxMs: number | undefined;
  let runsDir: string | undefined;
  // Bus flags (one required group: all absent = inactive).
  let busTo: string | undefined;
  let busRoot: string | undefined;
  let busRunId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' && !json && !stream) {
      return printUsageAndExit(output);
    } else if (arg === '--json' && !json) json = true;
    else if (arg === '--stream' && !stream) stream = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--duration-ms' && durationMs === undefined) {
      durationMs = parseMs(args[++i]);
      if (durationMs === undefined || durationMs < 1 || durationMs > SELF_LOOP_MAX_DURATION_MS) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else if (arg === '--interval-ms' && intervalMs === undefined) {
      intervalMs = parseMs(args[++i]);
      if (intervalMs === undefined || intervalMs < SELF_LOOP_MIN_INTERVAL_MS) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else if (arg === '--failure-backoff-max-ms' && failureBackoffMaxMs === undefined) {
      failureBackoffMaxMs = parseMs(args[++i]);
      if (failureBackoffMaxMs === undefined || failureBackoffMaxMs > SELF_LOOP_MAX_DURATION_MS) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
      runsDir = value;
    } else if (arg === '--bus-to' && busTo === undefined) {
      busTo = args[++i];
      if (typeof busTo !== 'string' || busTo.length === 0) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else if (arg === '--bus-root' && busRoot === undefined) {
      busRoot = args[++i];
      if (typeof busRoot !== 'string' || !isAbsolute(busRoot)) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else if (arg === '--bus-run-id' && busRunId === undefined) {
      busRunId = args[++i];
      if (typeof busRunId !== 'string' || busRunId.length === 0) {
        return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
      }
    } else {
      return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
    }
  }
  // Compatibility is explicit: --stream IS the machine-readable mode, so
  // combining it with --json is a usage error, refused before any pass runs.
  if (stream && json) {
    return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
  }
  if (durationMs === undefined) {
    return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
  }
  if (failureBackoffMaxMs !== undefined && failureBackoffMaxMs < (intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS)) {
    return reportUsageError(error, 'Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--failure-backoff-max-ms <ms>] [--runs-dir <abs>] [--apply] [--json | --stream] [--bus-to <label> --bus-root <abs> --bus-run-id <token>]');
  }
  // Validate the bus config group (all absent = inactive).
  let busConfig: SelfLoopBusConfig | null = null;
  const busParse = parseBusConfigGroup(busTo, busRoot, busRunId);
  if (!busParse.ok) {
    return reportUsageError(error, busParse.reason);
  }
  busConfig = busParse.ok ? busParse.value : null;
  // One root for the lock and all three steps of every pass, resolved here
  // once — same fallbacks as self-tick, so nothing can drift between passes.
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  const now = deps.now ?? Date.now;
  const realTick: SelfLoopTick = async () => {
    const captured: string[] = [];
    const exitCode = await cmdFleetSelfTick(
      ['--json', ...(apply ? ['--apply'] : []), '--runs-dir', root],
      {
        steps: deps.steps,
        now,
        output: (text) => captured.push(text),
        error,
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
  // When --bus-to/--bus-root/--bus-run-id are all present, write a compact
  // progress envelope after each completed pass through the existing durable
  // bus transport (appendBusInbox).  An accepted duplicate counts as delivery;
  // any other post result ends admission via observer-error (the tick is NOT
  // re-run) and produces nonzero exit.  An existing onPass is preserved and
  // awaited; a bus error becomes an observer-error that stops admission, and
  // the stream sink is still called first so existing --stream semantics
  // remain unchanged.
  let busPostFailure: { status: string } | undefined;
  const busInboxOptions = busConfig === null ? {} : { root: busConfig.root };
  const onBusPass = busConfig === null ? undefined : async (event: SelfLoopPassEvent) => {
    const envelope = buildProgressEnvelope(
      busConfig,
      event.pass,
      event.exitCode,
      event.state,
      event.consecutiveFailures,
      event.nextDelayMs,
    );
    const posted = postProgressEnvelope(envelope, busInboxOptions);
    if (posted.status !== 'posted' && posted.status !== 'duplicate') {
      busPostFailure = { status: posted.status };
    }
  };
  // Combine stream and bus observers into one onPass callback.  When neither
  // is configured we pass nothing so runSelfLoop keeps its default behavior.
  const combinedOnPass = (() => {
    if (onBusPass === undefined && !stream) return undefined;
    if (onBusPass === undefined) return (event: SelfLoopPassEvent) => {
      output(toStreamLine({
        v: 1, record: 'pass', pass: event.pass, exitCode: event.exitCode,
        state: event.state, report: event.report,
        ...(event.consecutiveFailures === undefined ? {} : {
          consecutiveFailures: event.consecutiveFailures, nextDelayMs: event.nextDelayMs,
        }),
      }, 'report'));
    };
    if (!stream) return onBusPass;
    // Both stream and bus: call stream first (existing --stream behavior),
    // then bus (new progress writing).
    return async (event: SelfLoopPassEvent) => {
      output(toStreamLine({
        v: 1, record: 'pass', pass: event.pass, exitCode: event.exitCode,
        state: event.state, report: event.report,
        ...(event.consecutiveFailures === undefined ? {} : {
          consecutiveFailures: event.consecutiveFailures, nextDelayMs: event.nextDelayMs,
        }),
      }, 'report'));
      await onBusPass(event);
    };
  })();
  const removeSignalListeners = onSignal(() => controller.abort());
  let summary;
  try {
    summary = await runSelfLoop({
      durationMs,
      intervalMs: intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS,
      ...(failureBackoffMaxMs === undefined ? {} : { failureBackoffMaxMs }),
      tick: deps.tick ?? realTick,
      now,
      signal: controller.signal,
      ...(combinedOnPass === undefined ? {} : { onPass: combinedOnPass }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } finally {
    removeSignalListeners();
  }
  // If the bus posted a non-posted outcome, mark observer-error and return 1.
  if (busPostFailure && busPostFailure.status !== 'posted' && busPostFailure.status !== 'duplicate') {
    summary = { ...summary, observerError: `bus-${busPostFailure.status}`, termination: 'observer-error' as const };
  }
  if (stream) {
    // Flattened so the unbounded lastReport sits at the record's top level,
    // where toStreamLine's size cap can reach it.
    output(toStreamLine({ ...summary, v: 1, record: 'summary' }, 'lastReport'));
  } else if (json) {
    output(JSON.stringify(sanitizePublicJson(summary)));
  } else {
    const label = summary.termination === 'observer-error' ? 'OBSERVER-ERROR'
      : summary.termination === 'interrupted' ? 'INTERRUPTED' : 'DONE';
    output(`fleet self-loop: ${label
    } — ticks=${summary.ticks} failed=${summary.failures} busy=${summary.busy} (${apply ? 'apply' : 'dry-run'})`);
  }
  return summary.failures > 0 || summary.observerError !== undefined ? 1 : 0;
}
