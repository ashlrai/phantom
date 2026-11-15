/**
 * `ashlr fleet cos-loop` — keeps the chief-of-staff worker drafting for a
 * bounded window with no external shell timer (RQ-PHX-COSLOOPVERB12).
 * Chief-of-staff tasks queued by the desktop box, Telegram and email wait
 * for `ashlr fleet cos-work` to answer them one pass at a time, and nothing
 * called it on its own; a host timer or an agent starts this loop once and
 * tasks get drafted without a person. Each pass is the real runCosWorkOnce
 * (the PAUSE switch, the one-job claim race, the declared runner slate and
 * the approval-bound draft stay inside it); this command adds only
 * repetition: first pass immediately, never overlapping. A 'drafted' pass
 * admits the next pass with no wait so a backlog drains; 'idle', 'paused',
 * 'blocked' and errored passes wait one interval. Admission stops at the
 * deadline; a pass already running then finishes normally. SIGINT/SIGTERM
 * stop admission and interrupt the wait without killing a running pass; the
 * summary prints either way. Five consecutive blocked passes with the same
 * reason (a dead runner slate) end the loop as 'blocked-streak'. It only
 * drafts — delivery still needs digest approval through a trusted surface.
 *
 * --stream opts into live progress: one sanitized NDJSON line
 * ({v:1,record:'pass',…}) is emitted the moment each pass completes, then
 * exactly one distinguishable final line ({v:1,record:'summary',…}) when the
 * loop ends — a supervising agent never waits for the whole window. Memory
 * stays constant: lines are written and dropped, nothing is accumulated.
 * --stream and --json are mutually exclusive (--json keeps its single final
 * summary line) and the combination is rejected before any pass runs.
 *
 * --max-passes <n> (integer 1..1000) is optional alongside --duration-ms:
 * whichever bound occurs first stops admission. Unknown or duplicate
 * options are refused before any pass runs.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  runCosLoop,
  COS_LOOP_DEFAULT_INTERVAL_MS,
  COS_LOOP_MAX_DURATION_MS,
  COS_LOOP_MAX_PASSES,
  COS_LOOP_MIN_INTERVAL_MS,
  type CosLoopPassEvent,
  type CosLoopWork,
  type RunCosLoopOptions,
} from '../core/cos/loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet cos-loop --duration-ms <ms> [--interval-ms <ms>] [--max-passes <n>] [--runs-dir <abs>] [--json | --stream]
Repeat the chief-of-staff worker pass (fleet cos-work) for a bounded window:
first pass immediately; after a 'drafted' pass the next pass runs with no
wait to drain the backlog, and after 'idle', 'paused', 'blocked' or an
errored pass the loop waits one interval (default 30000ms, minimum 5000ms),
never overlapping, until --duration-ms (maximum 24h) is reached. The
deadline only gates admission — a pass already running finishes normally.
SIGINT/SIGTERM stop admission and interrupt the wait without killing a
running pass; the summary prints either way. Five consecutive blocked
passes with the same reason stop the loop as 'blocked-streak'. Each pass
claims at most one cos-* intake job and records an approval-bound draft —
it sends nothing; delivery still needs digest approval. --max-passes <n>
(integer 1..1000) is optional alongside --duration-ms: whichever bound
occurs first stops admission. --json prints one final sanitized summary
line. --stream instead prints sanitized NDJSON live: one
{"v":1,"record":"pass",...} line per completed pass, then exactly one
{"v":1,"record":"summary",...} line. --stream and --json are mutually
exclusive and rejected before any pass runs. Exit 0 when the loop ended on
the deadline, the count cap or a signal with no errored pass, 1 on
'blocked-streak' or any errored pass, 2 on usage.`;

interface Dependencies {
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Full pass override; without it each pass is the real runCosWorkOnce. */
  work?: CosLoopWork;
  /** Sleep seam; rejects on abort. Defaults to the core real-time sleep. */
  sleep?: RunCosLoopOptions['sleep'];
  /** Signal seam; defaults to SIGINT+SIGTERM on this process. Returns the unregister. */
  onSignal?: (handler: () => void) => () => void;
}

export async function cmdFleetCosLoop(args: string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (): number => { error(`Invalid arguments. ${usage.split('\n')[0]}`); return 2; };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  let json = false, stream = false;
  let durationMs: number | undefined, intervalMs: number | undefined, runsDir: string | undefined;
  let maxPasses: number | undefined;
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
    else if (arg === '--duration-ms' && durationMs === undefined) {
      durationMs = parseMs(args[++i]);
      if (durationMs === undefined || durationMs < 1_000 || durationMs > COS_LOOP_MAX_DURATION_MS) return invalid();
    } else if (arg === '--interval-ms' && intervalMs === undefined) {
      intervalMs = parseMs(args[++i]);
      if (intervalMs === undefined || intervalMs < COS_LOOP_MIN_INTERVAL_MS) return invalid();
    } else if (arg === '--max-passes' && maxPasses === undefined) {
      const parsed = parsePositiveInt(args[++i]);
      if (parsed === undefined || parsed > COS_LOOP_MAX_PASSES) return invalid();
      maxPasses = parsed;
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
  // One root for every pass, resolved here once — same fallbacks as
  // cos-work, so nothing can drift between passes.
  const root = resolve(runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  const controller = new AbortController();
  const onSignal = deps.onSignal ?? ((handler: () => void) => {
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.removeListener('SIGINT', handler);
      process.removeListener('SIGTERM', handler);
    };
  });
  // In --stream mode each completed pass is emitted as one sanitized NDJSON
  // line the moment it finishes, so a supervisor sees progress while later
  // passes are still deferred. The record carries only the outcome and the
  // job id — never model output.
  const onPass = stream
    ? (event: CosLoopPassEvent): void => {
      output(JSON.stringify(sanitizePublicJson({
        v: 1, record: 'pass', pass: event.pass, outcome: event.outcome,
        ...(event.id === undefined ? {} : { id: event.id }),
      })));
    }
    : undefined;
  const removeSignalListeners = onSignal(() => controller.abort());
  let summary;
  try {
    summary = await runCosLoop({
      durationMs,
      ...(maxPasses === undefined ? {} : { maxPasses }),
      intervalMs: intervalMs ?? COS_LOOP_DEFAULT_INTERVAL_MS,
      runsDir: root,
      signal: controller.signal,
      ...(onPass === undefined ? {} : { onPass }),
      ...(deps.work === undefined ? {} : { work: deps.work }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  } catch (loopError) {
    const message = loopError instanceof Error ? loopError.message : 'cos-loop failed';
    if (json || stream) output(JSON.stringify(sanitizePublicJson({ error: message })));
    else error(message);
    return 1;
  } finally {
    removeSignalListeners();
  }
  if (stream) {
    output(JSON.stringify(sanitizePublicJson({ ...summary, v: 1, record: 'summary' })));
  } else if (json) {
    output(JSON.stringify(sanitizePublicJson(summary)));
  } else {
    const label = summary.termination === 'blocked-streak' ? 'BLOCKED-STREAK'
      : summary.termination === 'max-passes' ? 'MAX-PASSES'
        : summary.termination === 'signal' ? 'INTERRUPTED' : 'DONE';
    output(`fleet cos-loop: ${label} — passes=${summary.passes
    } drafted=${summary.drafted} idle=${summary.idle} paused=${summary.paused
    } blocked=${summary.blocked} errors=${summary.errors}`);
  }
  return summary.termination === 'blocked-streak' || summary.errors > 0 ? 1 : 0;
}
