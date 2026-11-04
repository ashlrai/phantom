/**
 * self-tick.ts — one locked pass of Phantom's self-management, runnable by an
 * agent or a host timer with no desktop app open. Seven one-shot verbs run
 * together, including same-channel inbox acknowledgements and merged-order notices.
 * runSelfTick is the single pass, each step injected as a seam in fixed order:
 *
 *   1. reset-release  — first, so a lane it frees counts as a free slot for
 *      the planner step's decision in the same pass.
 *   2. lane-autohold  — places the bounded burning-lane holds.
 *   3. planner-tick   — the autorun decision over the post-release picture.
 *   4. inbox-acks     — send pending same-channel acknowledgements.
 *   5. order-notices  — tell Mason when a merged job served one of his orders.
 *   6. meter-incidents — post P1 incidents for meters flat while jobs run.
 *   7. landed-sweep   — close DIRTY PRs whose work already landed on master.
 *
 * A step that exits nonzero or throws is recorded 'failed'; later steps still
 * run. A hold a person placed is never released — that rule stays inside the
 * verbs' guarded write paths.
 *
 * One self-tick per runs dir: the local-store lock on queue/self-tick.lock
 * gives O_CREAT|O_EXCL install plus dead-owner reclaim, so an abandoned lock
 * is recovered rather than wedging the timer. A run that cannot take the lock
 * does no step and reports 'busy'.
 */
import { join } from 'node:path';
import {
  acquireLocalStoreLockWithOutcome,
  releaseLocalStoreLock,
  type LocalStoreLockAcquireResult,
} from './local-store-lock.js';
import { writeSelfTickLast } from './self-tick-last.js';

export type SelfTickStepName = 'reset-release' | 'lane-autohold' | 'planner-tick' | 'inbox-acks' | 'order-notices' | 'meter-incidents' | 'landed-sweep';
/** Fixed execution order — release first so the planner sees freed slots; landed-sweep last. */
export const SELF_TICK_STEP_ORDER: readonly SelfTickStepName[] = [
  'reset-release',
  'lane-autohold',
  'planner-tick',
  'inbox-acks',
  'order-notices',
  'meter-incidents',
  // Last: the slowest step (gh + git reads) must never delay release or the planner.
  'landed-sweep',
];
/** Lock path relative to the runs dir, under the queue/ directory. */
export const SELF_TICK_LOCK = 'queue/self-tick.lock';

/** One step's captured run: its exit code plus the verbatim stdout text. */
export interface SelfTickStepRun {
  exitCode: number;
  output: string;
}
/** A step seam gets the shared argv (--json, maybe --apply, --runs-dir). */
export type SelfTickStep = (args: string[]) => Promise<SelfTickStepRun>;
export type SelfTickSteps = Record<SelfTickStepName, SelfTickStep>;

export interface SelfTickStepResult {
  step: SelfTickStepName;
  state: 'ok' | 'failed';
  exitCode: number;
  /** The step's parsed --json output, or null when nothing parseable printed. */
  report: unknown;
}

export interface SelfTickReport {
  v: 1;
  at: string;
  mode: 'apply' | 'dry-run';
  state: 'ran' | 'busy';
  steps: SelfTickStepResult[];
}

export interface SelfTickOutcome {
  report: SelfTickReport;
  /** 0 when every step is ok or the run was busy; 1 when any step failed. */
  exitCode: number;
  /** How the single-runner lock resolved; 'acquired' iff the steps ran. */
  lock: 'acquired' | 'contended' | 'unavailable';
}

export interface RunSelfTickOptions {
  /** Pass --apply to each step; without it nothing is released, held or spawned. */
  apply?: boolean;
  /** Resolved absolute runs dir; the lock and every step share it. */
  runsDir: string;
  now?: () => number;
  /** The step seams, keyed by step name. */
  steps: SelfTickSteps;
  /** Lock seam; defaults to the local-store lock on queue/self-tick.lock. */
  acquireLock?: (path: string) => LocalStoreLockAcquireResult;
  /**
   * Last-report seam; defaults to writeSelfTickLast on
   * queue/self-tick-last.json. Called only when the run state is 'ran',
   * while the lock is still held; a throwing write changes nothing.
   */
  writeLast?: (runsDir: string, report: SelfTickReport) => void;
}

const parseReport = (output: string): unknown => {
  const text = output.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

export async function runSelfTick(options: RunSelfTickOptions): Promise<SelfTickOutcome> {
  const report: SelfTickReport = {
    v: 1,
    at: new Date((options.now ?? Date.now)()).toISOString(),
    mode: options.apply === true ? 'apply' : 'dry-run',
    state: 'ran',
    steps: [],
  };
  const runsDir = options.runsDir;
  const acquire = options.acquireLock ?? ((path: string) =>
    acquireLocalStoreLockWithOutcome(path, 0, { anchorPath: runsDir, exactPrivateStorage: true }));
  const held = acquire(join(runsDir, SELF_TICK_LOCK));
  if (held.state !== 'acquired') {
    report.state = 'busy';
    return { report, exitCode: 0, lock: held.state };
  }
  const argv = ['--json', ...(options.apply === true ? ['--apply'] : []), '--runs-dir', runsDir];
  try {
    for (const step of SELF_TICK_STEP_ORDER) {
      try {
        const { exitCode, output } = await options.steps[step](argv);
        report.steps.push({
          step,
          state: exitCode === 0 ? 'ok' : 'failed',
          exitCode,
          report: parseReport(output),
        });
      } catch {
        report.steps.push({ step, state: 'failed', exitCode: 1, report: null });
      }
    }
    // Persisted while the lock is still held so a `--last` read can never
    // see a pass that is still mid-flight. A throwing write must not change
    // the steps' exit code or skip the release in finally.
    try {
      (options.writeLast ?? writeSelfTickLast)(runsDir, report);
    } catch { /* the record is best-effort; the run's result already stands */ }
  } finally {
    // Released on every path — a throwing step included. If the unlink itself
    // fails the dead-owner reclaim still frees the next tick.
    releaseLocalStoreLock(held.lock);
  }
  return {
    report,
    exitCode: report.steps.some((step) => step.state === 'failed') ? 1 : 0,
    lock: 'acquired',
  };
}
