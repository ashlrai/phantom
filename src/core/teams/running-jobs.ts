/** Running jobs per teammate. Jobs carry a lane, not a person, so a teammate's jobs are the running ones in the pools they bring. */
import { getFleetSessions, type FleetSessionsV1 } from '../fleet/runs-sessions.js';
import type { TeamPerson } from '../../shared/team-directory.js';

export interface MemberJobs {
  /** null: the fleet could not be read, so the count is unknown (never shown as zero). */
  running: number | null; jobs: string[];
}

export async function memberRunningJobs(people: readonly TeamPerson[], read: () => Promise<Pick<FleetSessionsV1, 'sessions'>> = () => getFleetSessions()): Promise<Record<string, MemberJobs>> {
  let sessions: Pick<FleetSessionsV1, 'sessions'>['sessions'] | null = null;
  try { sessions = (await read()).sessions.filter(s => s.status === 'running'); } catch { /* unknown, not zero */ }
  return Object.fromEntries(people.map(p => {
    if (!sessions) return [p.id, { running: null, jobs: [] }];
    const jobs = sessions.filter(s => s.lane !== null && p.lanes.includes(s.lane)).map(s => s.job);
    return [p.id, { running: jobs.length, jobs }];
  }));
}
