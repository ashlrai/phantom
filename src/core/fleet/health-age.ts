/** Read-only guardian freshness; never substitutes the file modification time. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAIN_HEALTH_STALE_MS } from './main-health.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';

export interface FleetHealthAge {
  v: 1;
  readOnly: true;
  status: 'fresh' | 'stale' | 'missing file' | 'unreadable file' | 'missing timestamp' | 'malformed timestamp' | 'future timestamp';
  statusAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
}

export async function readFleetHealthAge(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetHealthAge> {
  const source = await readSource(join(opts.runsDir ?? join(homedir(), '.ashlr-runs'),
    'supervisor', 'status-main-guardian.md'), 256 * 1024, false);
  const report: FleetHealthAge = {
    v: 1, readOnly: true, status: 'missing timestamp', statusAt: null,
    ageSeconds: null, maxAgeSeconds: MAIN_HEALTH_STALE_MS / 1000,
  };
  if (source.state !== 'healthy') {
    report.status = source.state === 'missing' ? 'missing file' : 'unreadable file';
    return report;
  }
  const heading = source.text.split('\n').find(line => line.startsWith('# Main guardian status'));
  if (!heading) return report;
  const match = /^# Main guardian status \((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?: [A-Za-z]{1,5})?\)\s*$/.exec(heading);
  const stamp = match ? localTimestamp(match[1]!) : null;
  if (!stamp || !Number.isFinite(stamp.ms)) {
    report.status = 'malformed timestamp';
    return report;
  }
  const ageMs = (opts.now ?? Date.now)() - stamp.ms;
  report.statusAt = stamp.at;
  report.ageSeconds = ageMs / 1000;
  report.status = ageMs < 0 ? 'future timestamp' : ageMs > MAIN_HEALTH_STALE_MS ? 'stale' : 'fresh';
  return report;
}
