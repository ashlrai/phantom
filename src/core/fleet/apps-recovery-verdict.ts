/** Verdict about retained evidence only; this does not probe a running process. */
import type { readAppsRecoveryInvocations } from './apps-recovery-invocations.js';

type Projection = ReturnType<typeof readAppsRecoveryInvocations>;
type Verdict = 'healthy' | 'unhealthy' | 'stale' | 'terminal' | 'unknown';

export function appsRecoveryVerdict(projection: Projection, invocationId: string, maxAgeMs: number, now: number) {
  const row = projection.invocations.find(item => item.invocationId.toLowerCase() === invocationId.toLowerCase());
  const latestTime = row && Number.isFinite(row.latestTime) ? row.latestTime : null;
  const ageMs = latestTime !== null && Number.isFinite(now) && latestTime >= 0 && latestTime <= now ? now - latestTime : null;
  let verdict: Verdict = 'unknown';
  if (projection.availability === 'available' && row) {
    if (row.terminalOutcome) verdict = 'terminal';
    else if (!projection.truncated && ageMs !== null && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      if (ageMs > maxAgeMs) verdict = 'stale';
      else if (row.retainedHealthy === false) verdict = 'unhealthy';
      else if (row.retainedHealthy === true && row.retainedObservedState?.length &&
        row.retainedObservedState.every(item => item.observedRunning === true) &&
        (row.retainedDiagnostics === null || row.retainedDiagnostics.every(item =>
          (item.outcome === 'running' || item.outcome === 'launched') &&
          row.retainedObservedState!.some(state => state.app === item.app)))) verdict = 'healthy';
    }
  }
  return { v: 1 as const, invocationId, verdict, latestCursor: row?.latestCursor ?? null, latestTime,
    ageMs, terminalOutcome: row?.terminalOutcome ?? null, truncated: projection.truncated };
}
