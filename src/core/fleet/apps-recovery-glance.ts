/** One incident from the newest retained recovery invocation; no live probes. */
import type { readAppsRecoveryInvocations } from './apps-recovery-invocations.js';
import { appsRecoveryVerdict } from './apps-recovery-verdict.js';

export function appsRecoveryIncident(
  projection: ReturnType<typeof readAppsRecoveryInvocations>, now: number, maxAgeMs = 30 * 60_000,
): string | null {
  const row = projection.invocations[0];
  if (projection.availability !== 'available' || !row) return null;
  const result = appsRecoveryVerdict(projection, row.invocationId, maxAgeMs, now);
  const down = row.retainedObservedState?.filter(item => item.observedRunning !== true).map(item => item.app);
  const names = down?.length ? down : row.observedApps ?? [];
  const apps = names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') : 'apps';
  let line: string;
  if (result.verdict === 'terminal' && result.terminalOutcome === 'failed') line = `App recovery failed: ${apps}`;
  else if (result.verdict === 'unhealthy') line = `App recovery retrying: ${apps} (${row.consecutiveFailures} failed)`;
  else if (result.verdict === 'stale' && result.terminalOutcome === null) line = `App recovery silent for ${Math.floor(result.ageMs! / 60_000)} min`;
  else return null;
  return line.length > 79 ? `${line.slice(0, 78)}…` : line;
}
