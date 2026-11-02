/**
 * One chip per repo for the desktop glance: is main green, when did the
 * guardian last pass, how many fix jobs are open. Read from the main-guardian
 * status table through the existing reader; never throws.
 */
import { readFleetMainHealth } from './main-health.js';

export const GUARDIAN_STALE_MINUTES = 90;

export interface GuardianGlanceRow {
  repo: string;
  state: 'green' | 'red' | 'unknown';
  lastPassAt: string | null;
  ageMinutes: number | null;
  openFixes: number;
  stale: boolean;
}

const rank = (row: GuardianGlanceRow): number => (row.state === 'red' ? 0 : row.stale ? 1 : 2);

/** Red first, then stale or unknown, then green; repo name breaks ties. */
export async function readGuardianGlance(runsDir: string, now: number): Promise<GuardianGlanceRow[]> {
  try {
    const health = await readFleetMainHealth({ runsDir, now: () => now });
    return health.repos.map((repo): GuardianGlanceRow => {
      const ms = Date.parse(repo.checkedAt ?? '');
      const age = Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 60_000)) : null;
      return {
        repo: repo.repo,
        state: repo.state,
        lastPassAt: age === null ? null : repo.checkedAt,
        ageMinutes: age,
        openFixes: repo.fixJobs.length,
        stale: age === null || age > GUARDIAN_STALE_MINUTES,
      };
    }).sort((a, b) => rank(a) - rank(b) || a.repo.localeCompare(b.repo));
  } catch {
    return [];
  }
}
