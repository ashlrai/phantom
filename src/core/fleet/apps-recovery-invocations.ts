/** Bounded projection of retained, validated apps-watch history; never infers live state. */
import { readAppsRecoveryHistory } from './apps-recovery-history.js';
import type { AppsWatchDiagnostic, AppsWatchState } from './apps-watch-bus.js';

const MAX_ROWS = 1024;
const MAX_GROUPS = 100;
type HistoryReader = typeof readAppsRecoveryHistory;
type Invocation = {
  invocationId: string; latestCursor: number; latestTime: number;
  observedApps: string[] | null;
  retainedObservedState: AppsWatchState; retainedDiagnostics: AppsWatchDiagnostic[] | null;
  retainedHealthy: boolean | null; recoveries: number; consecutiveFailures: number;
  totalFailedCycles: number; terminalOutcome: 'completed' | 'failed' | 'cancelled' | null;
};

export function readAppsRecoveryInvocations(root: string, reader: HistoryReader = readAppsRecoveryHistory) {
  const groups = new Map<string, Invocation>();
  let cursor = 0, scanned = 0, truncated = false;
  let availability: 'available' | 'unavailable' | 'invalid-cursor' = 'available';
  while (scanned < MAX_ROWS) {
    const page = reader(root, cursor, Math.min(100, MAX_ROWS - scanned));
    if (page.availability !== 'available') {
      availability = page.availability as 'unavailable' | 'invalid-cursor';
      break;
    }
    for (const event of page.events) {
      const id = event.invocationId as string;
      const previous = groups.get(id);
      const state = event.kind === 'apps-watch.summary.v1' ? event.lastObservedState : event.observedState;
      const observedApps = Array.isArray(state) ? state.map((row: { app: string }) => row.app) : previous?.observedApps ?? null;
      const outcome = event.kind === 'apps-watch.summary.v1'
        ? event.outcome as Invocation['terminalOutcome'] : previous?.terminalOutcome ?? null;
      groups.delete(id);
      groups.set(id, { invocationId: id, latestCursor: event.cursor as number, latestTime: event.receivedAt as number,
        observedApps, retainedObservedState: state as AppsWatchState,
        retainedDiagnostics: (event.kind === 'apps-watch.summary.v1' ? event.lastDiagnostics : event.diagnostics) as AppsWatchDiagnostic[] | null ?? null,
        retainedHealthy: event.kind === 'apps-watch.observation.v1' ? event.healthy as boolean : null,
        recoveries: event.recoveries as number, consecutiveFailures: event.consecutiveFailures as number,
        totalFailedCycles: event.totalFailedCycles as number, terminalOutcome: outcome });
      if (groups.size > MAX_GROUPS) { groups.delete(groups.keys().next().value!); truncated = true; }
      scanned++;
    }
    const prior = cursor;
    cursor = page.nextCursor;
    if (!page.hasMore) break;
    if (cursor <= prior || scanned >= MAX_ROWS) { truncated = true; break; }
  }
  return { v: 1 as const, availability, truncated: truncated || availability !== 'available', scanCursor: cursor,
    scannedEvents: scanned, invocations: [...groups.values()].sort((a, b) => b.latestCursor - a.latestCursor || a.invocationId.localeCompare(b.invocationId)) };
}
