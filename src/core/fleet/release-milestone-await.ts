import { performance } from 'node:perf_hooks';
import { abortableSleep, boundedAwait, wireAwaitCancel } from '../util/await-support.js';
import { fetchLatestRelease, observeMilestones, type MilestoneObservation, type MilestoneReader, type ReleaseRunner } from './release-live-notice.js';

export type ReleaseAwaitStage = 'published' | 'feed-ready';
export interface ReleaseAwaitDeps {
  now?: () => number;
  wallNow?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  run?: ReleaseRunner;
  feed?: MilestoneReader;
}
export interface ReleaseAwaitResult {
  outcome: 'observed' | 'timed-out' | 'cancelled';
  repo: string; tag: string; stage: ReleaseAwaitStage;
  elapsedMs: number; attempts: number; observations: MilestoneObservation[];
}

export async function awaitReleaseMilestone(options: { repo: string; tag: string; stage: ReleaseAwaitStage;
  timeoutMs: number; pollMs: number; signal?: AbortSignal }, deps: ReleaseAwaitDeps = {}): Promise<ReleaseAwaitResult> {
  const { repo, tag, stage, timeoutMs, pollMs, signal } = options;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const start = now(), deadline = start + timeoutMs;
  const result: ReleaseAwaitResult = { outcome: 'timed-out', repo, tag, stage, elapsedMs: 0, attempts: 0, observations: [] };
  const controller = new AbortController();
  const detach = wireAwaitCancel(controller, signal);
  // Existing readers have no signal parameter. Stop waiting at the deadline and
  // never start another reader after cancellation, even if a late read resolves.
  const bounded = async <T>(operation: () => Promise<T>, deadlineMs: number): Promise<T | undefined> => {
    const raced = await boundedAwait(operation, { cancel: controller.signal, deadlineMs, now });
    return raced.kind === 'value' ? raced.value : undefined;
  };
  try {
    while (!controller.signal.aborted && (result.attempts === 0 || now() < deadline)) {
      result.attempts++;
      const sample = await bounded(async () => {
        const fact = await fetchLatestRelease(repo, deps.run, tag);
        if (controller.signal.aborted) return undefined;
        return observeMilestones(repo, tag, fact, new Date((deps.wallNow ?? Date.now)()), deps.feed);
      }, timeoutMs === 0 ? now() + 10_000 : deadline);
      if (controller.signal.aborted) break;
      if (!sample || (timeoutMs > 0 && now() >= deadline)) break;
      result.observations = sample;
      if (sample[0]?.status === 'observed' && (stage === 'published' || sample[1]?.status === 'observed')) {
        result.outcome = 'observed'; break;
      }
      if (timeoutMs === 0 || now() >= deadline) break;
      const waited = await bounded(async () => { await sleep(Math.min(pollMs, deadline - now()), controller.signal); return true; }, deadline);
      if (!waited) break;
    }
    if (controller.signal.aborted) result.outcome = 'cancelled';
  } finally {
    detach();
    result.elapsedMs = Math.max(0, now() - start);
  }
  return result;
}
