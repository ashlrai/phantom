import type { DaemonTickPhase } from '../types.js';
import { recordTickPhase, runTickPhase, TICK_PHASE_GRACE_MS } from './tick-phases.js';

type History = Pick<NonNullable<DaemonTickPhase['offTick']>, 'lastStatus' | 'lastDurationMs' | 'lastSettledAt' | 'lastError'>;

interface Job {
  name: string;
  run: number;
  since: string;
  running: boolean;
  controller: AbortController;
  done: Promise<void>;
  last: History;
}

const jobs = new Map<string, Job>();

export function launchOffTickJob(
  name: string,
  run: (signal: AbortSignal) => Promise<unknown>,
  opts: {
    deadlineMs: number;
    graceMs?: number;
    parentSignal?: AbortSignal;
    log?: (line: string) => void;
    nowMs?: () => number;
  },
): DaemonTickPhase {
  const previous = jobs.get(name);
  let job = previous;
  const state = previous?.running ? 'running' : 'started';
  if (!previous?.running) {
    const now = opts.nowMs ?? Date.now;
    const controller = new AbortController();
    job = {
      name, run: (previous?.run ?? 0) + 1, since: new Date(now()).toISOString(),
      running: true, controller, done: Promise.resolve(), last: { ...previous?.last },
    };
    jobs.set(name, job);
    const current = job;
    const abort = (): void => controller.abort();
    if (opts.parentSignal?.aborted) abort();
    else opts.parentSignal?.addEventListener('abort', abort, { once: true });
    let innerSettled: Promise<unknown> = Promise.resolve();
    const bounded = runTickPhase(name, (signal) => {
      const inner = Promise.resolve().then(() => run(signal));
      innerSettled = inner.then(() => undefined, () => undefined);
      return inner;
    }, { ...opts, parentSignal: controller.signal, detached: true });
    current.done = bounded.then(async (result) => {
      await innerSettled;
      current.last = {
        lastStatus: result.status, lastDurationMs: result.durationMs,
        lastSettledAt: new Date(now()).toISOString(),
        ...(result.error !== undefined ? { lastError: result.error } : {}),
      };
      if (result.status === 'skipped') {
        try {
          opts.log?.(`[off-tick] job ${name.slice(0, 120)} skipped: ${result.error ?? 'no detail'}`);
        } catch { /* logging must not break job settlement */ }
      }
    }).finally(() => {
      current.running = false;
      opts.parentSignal?.removeEventListener('abort', abort);
    });
  }
  const active = job!;
  const record: DaemonTickPhase = {
    name: name.slice(0, 120), status: 'off-tick', durationMs: 0,
    error: `off-tick: ${state === 'running' ? 'still running since' : 'started run ' + active.run + ' since'} ${active.since}${state === 'running' ? ` (run ${active.run})` : ''}`,
    offTick: { state, run: active.run, since: active.since, ...active.last },
  };
  recordTickPhase(record);
  return record;
}

export function offTickJobsSnapshot(): Array<{ name: string; running: boolean; run: number; since: string } & History> {
  return [...jobs.values()].map(({ name, running, run, since, last }) => ({ name, running, run, since, ...last }));
}

export async function cancelOffTickJobs(graceMs = TICK_PHASE_GRACE_MS): Promise<void> {
  const running = [...jobs.values()].filter((job) => job.running);
  for (const job of running) job.controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(running.map((job) => job.done)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, graceMs)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resetOffTickJobsForTests(): void {
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
}
