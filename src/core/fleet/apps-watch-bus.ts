/** Best-effort publication of normalized apps-watch events to the durable bus. */
import { randomUUID } from 'node:crypto';
import { appendBusInbox } from './bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';

export type AppsWatchState = { app: string; observedRunning: boolean | null }[] | null;
export type AppsWatchEvent = {
  kind: 'apps-watch.observation.v1'; cycle: number; healthy: boolean; recoveries: number;
  consecutiveFailures: number; totalFailedCycles: number; observedState: AppsWatchState;
} | {
  kind: 'apps-watch.summary.v1'; apps: string[]; outcome: 'completed' | 'failed' | 'cancelled';
  cycles: number; recoveries: number; consecutiveFailures: number; totalFailedCycles: number;
  lastObservedState: AppsWatchState;
};

export function createAppsWatchPublisher(root: string, append = appendBusInbox): (event: AppsWatchEvent) => boolean {
  const invocationId = randomUUID();
  let prior: string | undefined;
  return event => {
    try {
      const envelope: BusEnvelope = {
        id: `apps-watch-${invocationId}-${event.kind === 'apps-watch.observation.v1' ? `cycle-${event.cycle}` : 'summary'}`,
        from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 24 * 60 * 60 * 1000,
        body: { ...event, invocationId },
      };
      if (!validateBusEnvelope(envelope).ok) return false;
      const state = event.kind === 'apps-watch.observation.v1'
        ? JSON.stringify([event.healthy, event.observedState === null ? null :
          event.observedState.map(row => JSON.stringify([row.app, row.observedRunning])).sort()])
        : undefined;
      if (event.kind === 'apps-watch.observation.v1' && event.recoveries === 0 && state === prior) return true;
      const result = append(envelope, { root });
      const success = result.status === 'posted' || result.status === 'duplicate';
      if (success && state !== undefined) prior = state;
      return success;
    } catch { return false; }
  };
}
