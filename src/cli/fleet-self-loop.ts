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
  type SelfLoopTick,
} from '../core/fleet/self-loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet self-loop --duration-ms <ms> [--interval-ms <ms>] [--runs-dir <abs>] [--apply] [--json]
Repeat the self-management pass (fleet self-tick) for a bounded window:
first pass immediately, then one pass every interval (default 60000ms,
minimum 1000ms), never overlapping, until --duration-ms (maximum 24h) is
reached. The deadline only gates admission — a pass already running finishes
normally. SIGINT/SIGTERM stop admission and interrupt the wait without
killing a running pass; the summary prints either way. Each pass is the real
self-tick with its own queue/self-tick.lock: a contended pass counts 'busy'
and the loop continues, as does a failed pass. Exit 0 when no pass failed,
1 when any did, 2 on usage.`;

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
  let json = false, apply = false;
  let durationMs: number | undefined, intervalMs: number | undefined, runsDir: string | undefined;
  const parseMs = (value: string | undefined): number | undefined => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--duration-ms' && durationMs === undefined) {
      durationMs = parseMs(args[++i]);
      if (durationMs === undefined || durationMs < 1 || durationMs > SELF_LOOP_MAX_DURATION_MS) return invalid();
    } else if (arg === '--interval-ms' && intervalMs === undefined) {
      intervalMs = parseMs(args[++i]);
      if (intervalMs === undefined || intervalMs < SELF_LOOP_MIN_INTERVAL_MS) return invalid();
    } else if (arg === '--runs-dir' && runsDir === undefined) {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) return invalid();
      runsDir = value;
    } else return invalid();
  }
  if (durationMs === undefined) return invalid();
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
  const removeSignalListeners = onSignal(() => controller.abort());
  let summary;
  try {
    summary = await runSelfLoop({
      durationMs,
      intervalMs: intervalMs ?? SELF_LOOP_DEFAULT_INTERVAL_MS,
      tick: deps.tick ?? realTick,
      now,
      signal: controller.signal,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
  } finally {
    removeSignalListeners();
  }
  if (json) {
    output(JSON.stringify(sanitizePublicJson(summary)));
  } else {
    output(`fleet self-loop: ${summary.termination === 'interrupted' ? 'INTERRUPTED' : 'DONE'
    } — ticks=${summary.ticks} failed=${summary.failures} busy=${summary.busy} (${apply ? 'apply' : 'dry-run'})`);
  }
  return summary.failures > 0 ? 1 : 0;
}
