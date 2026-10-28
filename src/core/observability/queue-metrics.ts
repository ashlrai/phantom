/** Deterministic single-server queue.v1 measurements. Timestamps are milliseconds. */
export interface QueueEvent {
  jobId: string;
  kind: 'arrival' | 'start' | 'complete';
  atMs: number;
}

export interface QueueMetrics {
  schema: 'queue.v1';
  /** Arrivals per second over the observation window. */
  lambda: number;
  /** Completions per busy second; null without completions or positive busy time. */
  mu: number | null;
  /** Offered load lambda / mu; may exceed one in an overloaded window. */
  rho: number | null;
  /** Time-weighted mean jobs in the system (waiting plus running). */
  L: number;
  /** Mean arrival-to-completion seconds for completed jobs only. */
  W: number | null;
  /** Jobs still waiting or running at the end of the window. */
  WIP: number;
}

/**
 * Replay a chronological log for an initially empty single-server queue.
 * Events at either boundary are included, in log order. Open jobs contribute
 * to L and WIP but not W: Little's law need not hold in a censored window.
 * No M/M/1 distribution or steady-state assumption is imposed on the log.
 */
export function replayQueueMetrics(
  events: readonly QueueEvent[],
  window: { startMs: number; endMs: number },
): QueueMetrics {
  const { startMs, endMs } = window;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('Queue observation window must have finite, increasing boundaries');
  }
  const jobs = new Map<string, { arrival: number; started: boolean }>();
  const seen = new Set<string>();
  let running: string | undefined;
  let previous = startMs;
  let arrivals = 0;
  let completions = 0;
  let occupancyMs = 0;
  let busyMs = 0;
  let residenceMs = 0;
  for (const event of events) {
    if (!Number.isFinite(event.atMs) || event.atMs < previous || event.atMs > endMs) {
      throw new Error('Queue events must be chronological and inside the observation window');
    }
    const elapsed = event.atMs - previous;
    occupancyMs += jobs.size * elapsed;
    if (running !== undefined) busyMs += elapsed;
    previous = event.atMs;
    const job = jobs.get(event.jobId);
    switch (event.kind) {
      case 'arrival':
        if (!event.jobId || seen.has(event.jobId)) throw new Error('Duplicate or empty queue job ID');
        seen.add(event.jobId);
        jobs.set(event.jobId, { arrival: event.atMs, started: false });
        arrivals++;
        break;
      case 'start':
        if (!job || job.started || running !== undefined) throw new Error('Invalid queue service start');
        job.started = true;
        running = event.jobId;
        break;
      case 'complete':
        if (!job || running !== event.jobId) throw new Error('Invalid queue completion');
        residenceMs += event.atMs - job.arrival;
        completions++;
        jobs.delete(event.jobId);
        running = undefined;
        break;
      default:
        throw new Error('Unknown queue event kind');
    }
  }
  occupancyMs += jobs.size * (endMs - previous);
  if (running !== undefined) busyMs += endMs - previous;
  const durationMs = endMs - startMs;
  const lambda = arrivals * 1_000 / durationMs;
  const mu = busyMs > 0 && completions > 0 ? completions * 1_000 / busyMs : null;
  return {
    schema: 'queue.v1', lambda, mu, rho: mu === null ? null : lambda / mu,
    L: occupancyMs / durationMs,
    W: completions > 0 ? residenceMs / completions / 1_000 : null,
    WIP: jobs.size,
  };
}
