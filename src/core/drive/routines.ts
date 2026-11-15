/** Local driver stub contract. Pure routines consume snapshots, never send messages. */
export interface DriveStatus {
  schemaVersion: 1;
  observedAt: string;
  main: 'green' | 'red' | 'unknown';
  lanes: { id: string; queued: number; running: number; paused?: boolean }[];
}
export interface DriveJob {
  id: string;
  state: 'queued' | 'running' | 'completed' | 'failed';
  updatedAt: string;
  prUrl?: string;
}
export interface DriveReport {
  schemaVersion: 1;
  generatedAt: string;
  health: string[];
  levers: { id: string; count: number; action: string }[];
  prLinks: string[];
}

export function parseDriveInputs(statusText: string, jobsText: string): { status: DriveStatus; jobs: DriveJob[] } {
  const status = JSON.parse(statusText) as DriveStatus;
  if (!status || status.schemaVersion !== 1 || typeof status.observedAt !== 'string' || !Number.isFinite(Date.parse(status.observedAt)) ||
      !['green', 'red', 'unknown'].includes(status.main) || !Array.isArray(status.lanes) ||
      status.lanes.some(lane => !lane || typeof lane.id !== 'string' || !lane.id ||
        !Number.isSafeInteger(lane.queued) || lane.queued < 0 ||
        !Number.isSafeInteger(lane.running) || lane.running < 0 ||
        (lane.paused !== undefined && typeof lane.paused !== 'boolean'))) {
    throw new Error('Invalid drive status snapshot');
  }
  const jobs = jobsText.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as DriveJob);
  if (jobs.some(job => !job || typeof job.id !== 'string' || !job.id ||
      !['queued', 'running', 'completed', 'failed'].includes(job.state) ||
      typeof job.updatedAt !== 'string' || !Number.isFinite(Date.parse(job.updatedAt)) ||
      (job.prUrl !== undefined && typeof job.prUrl !== 'string'))) {
    throw new Error('Invalid drive jobs journal');
  }
  // Journals may contain multiple transitions. The last record is authoritative.
  return { status, jobs: [...new Map(jobs.map(job => [job.id, job])).values()] };
}

export function buildDriveReport(status: DriveStatus, jobs: DriveJob[], now = new Date()): DriveReport {
  const health: string[] = [];
  const stale = now.getTime() - Date.parse(status.observedAt);
  const snapshotUnhealthy = stale > 15 * 60_000 || stale < -60_000;
  if (snapshotUnhealthy) health.push('Driver status is stale or clock is ahead');
  if (status.main !== 'green') health.push(`Main checks: ${status.main}`);
  const stuck = jobs.filter(job => job.state === 'running' && now.getTime() - Date.parse(job.updatedAt) > 30 * 60_000);
  for (const job of stuck) health.push(`Stuck job: ${job.id}`);
  const empty = status.lanes.filter(lane => !lane.paused && lane.queued === 0 && lane.running === 0);
  for (const lane of empty) health.push(`Empty lane: ${lane.id}`);
  const failed = jobs.filter(job => job.state === 'failed').length;
  const levers = [
    { id: 'snapshot', count: snapshotUnhealthy ? 1 : 0, action: 'Refresh driver snapshot before making decisions' },
    { id: 'main', count: status.main !== 'green' ? 1 : 0, action: 'Verify and restore green main before dispatch' },
    { id: 'stuck', count: stuck.length, action: 'Inspect stalled jobs before retrying' },
    { id: 'empty', count: empty.length, action: 'Restock idle Mac lanes with ready work' },
    { id: 'failed', count: failed, action: 'Review failed jobs and remove recurring blockers' },
  ].filter(lever => lever.count > 0).sort((a, b) => b.count - a.count).slice(0, 3);
  const prLinks = [...new Set(jobs.flatMap(job =>
    job.prUrl && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(job.prUrl)
      ? [job.prUrl] : []))].sort();
  return { schemaVersion: 1, generatedAt: now.toISOString(), health, levers, prLinks };
}
