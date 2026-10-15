/**
 * Zombie-aware process liveness for tests that assert a killed process is gone.
 *
 * `process.kill(pid, 0)` succeeds for a zombie: a process that has exited but
 * whose exit status its parent has not collected yet. A killed grandchild is
 * reparented to PID 1 (or a subreaper), and in a container whose init reaps
 * orphans slowly or never (`docker run` without `--init`, sandbox supervisors)
 * it stays a zombie for seconds or forever. A zombie runs no code and holds no
 * descriptors, so it IS terminated; any other state (R, S, D, T, t, I, ...)
 * is alive.
 *
 * Termination is also asynchronous: SIGKILL is delivered when the target is
 * next scheduled. So tests poll to a bounded deadline instead of sleeping a
 * fixed interval and checking once.
 */
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Linux process state letter from /proc/<pid>/stat, `null` when the pid has
 * no /proc entry, or `undefined` when /proc is unavailable or unreadable.
 */
function procState(pid: number): string | null | undefined {
  if (process.platform !== 'linux') return undefined;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  // "pid (comm) S ppid ...": comm may itself contain ") ", so use the last one.
  const close = stat.lastIndexOf(') ');
  return close < 0 ? undefined : stat.charAt(close + 2) || undefined;
}

/**
 * True while `pid` names a process that has not terminated. Exited-but-unreaped
 * (zombie, Z) and dead (X) processes are not running. EPERM means the pid
 * exists under another user, so it is running.
 */
export function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${String(pid)}`);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  const state = procState(pid);
  if (state === null) return false;
  return state !== 'Z' && state !== 'X';
}

export interface ProcessExitWaitOptions {
  /** Upper bound on the wait. Default 2000 ms. */
  timeoutMs?: number;
  /** Poll interval. Default 20 ms. */
  intervalMs?: number;
}

/**
 * Polls until every pid has terminated (see {@link processIsRunning}) or the
 * deadline passes. Resolves true when all have terminated; false when any is
 * still running at the deadline. A pid is checked once more after the
 * deadline, so a slow machine is never failed on a stale sample.
 */
export async function waitForProcessExit(
  pids: number | readonly number[],
  { timeoutMs = 2_000, intervalMs = 20 }: ProcessExitWaitOptions = {},
): Promise<boolean> {
  const all = typeof pids === 'number' ? [pids] : [...pids];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!all.some(processIsRunning)) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}
