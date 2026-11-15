export interface RecoveryRow { label: string; tone: 'muted' | 'success' | 'warning'; ageText: string; canRetry: boolean }
const labels: Record<string, string> = { recovered: 'recovered', failed: 'recovery failed', 'gave-up': 'recovery gave up', cancelled: 'recovery cancelled', stale: 'recovery stale' };
export function appRecoveryRow(raw: unknown, app: string, now = Date.now()): RecoveryRow {
  const empty: RecoveryRow = { label: 'no recovery recorded', tone: 'muted', ageText: '', canRetry: false };
  if (!raw || typeof raw !== 'object' || !('v' in raw) || raw.v !== 1 || !('apps' in raw) || !Array.isArray(raw.apps)) return empty;
  const row: unknown = raw.apps.find((item: unknown) => item && typeof item === 'object' && 'app' in item && item.app === app);
  if (!row || typeof row !== 'object' || !('outcome' in row) || typeof row.outcome !== 'string'
    || !Object.hasOwn(labels, row.outcome) || !('at' in row) || typeof row.at !== 'number'
    || !Number.isFinite(row.at) || row.at < 0 || !Number.isFinite(now) || row.at > now) return empty;
  const minutes = Math.floor((now - row.at) / 60_000);
  const ageText = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  const canRetry = row.outcome === 'failed' || row.outcome === 'gave-up';
  return { label: labels[row.outcome]!, tone: canRetry ? 'warning' : row.outcome === 'recovered' ? 'success' : 'muted', ageText, canRetry };
}
