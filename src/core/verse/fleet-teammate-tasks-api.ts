import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { listTeammateTasks } from '../comms/imessage-teammate-tasks.js';

const MAX_ROWS = 50;
type Raw = ReturnType<typeof listTeammateTasks>;
type RawTask = Raw['tasks'][number];
const COUNT_KEYS = ['queued', 'sending', 'pending', 'replied', 'expired', 'cancelled'] as const;

/**
 * Honest work state. queued/sending -> ASSIGNED (the queue claim is reserved to imsg:<peer> at enqueue).
 * pending -> RUNNING (send receipt confirmed). replied+DONE -> REPORTED_DONE (peer-reported, never VERIFIED).
 * replied+BLOCKED/FAILED -> BLOCKED. expired -> UNKNOWN (remote execution is unknown). cancelled -> CANCELLED.
 */
function workState(t: RawTask): string {
  switch (t.state) {
    case 'queued': case 'sending': return 'ASSIGNED';
    case 'pending': return 'RUNNING';
    case 'replied': return t.result?.status === 'DONE' ? 'REPORTED_DONE' : 'BLOCKED';
    case 'cancelled': return 'CANCELLED';
    default: return 'UNKNOWN';
  }
}

/** Allow-list projection: token, receipt, claimKey, resource, metrics, result summary never leave this function. */
export function projectTeammateTasks(raw: Raw, nowIso: string, jobId?: string) {
  // Counts cover the complete selected set before the presentation cap, as in the unfiltered view.
  const selected = jobId === undefined ? raw.tasks : raw.tasks.filter(t => t.jobId === jobId);
  const counts = Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as Record<typeof COUNT_KEYS[number], number>;
  for (const t of selected) counts[t.state]++;
  const sorted = [...selected].sort((a, b) => b.createdAt - a.createdAt);
  const rows = sorted.slice(0, MAX_ROWS).map(t => ({
    jobId: t.jobId, peer: t.peer, kind: t.kind, repo: t.repo, prRefs: [...t.prRefs],
    workState: workState(t), deadline: t.deadline, createdAt: new Date(t.createdAt).toISOString(),
  }));
  return { schema: raw.schema, asOf: nowIso, counts, rows, truncated: sorted.length > MAX_ROWS,
    ...(jobId === undefined ? {} : { selection: { jobId }, matched: selected.length > 0 }) };
}

/** Read-only: never enqueues, cancels, runs or takes the store lock. */
export function createFleetTeammateTasksApi(read: () => Raw | Promise<Raw> = () => listTeammateTasks(), now: () => Date = () => new Date()): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/teammate-tasks') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const entries = [...params.entries()];
    const jobId = entries[0]?.[1];
    if (entries.length > 1 || (entries.length === 1 && (entries[0]![0] !== 'job' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(jobId!) || scrubSecrets(jobId!) !== jobId))) {
      sendJson(res, 400, { error: 'invalid query parameters' }); return true;
    }
    let body;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => read()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5_000); }),
      ]);
      if (raw.state !== 'healthy') throw new Error('unavailable');
      body = projectTeammateTasks(raw, now().toISOString(), jobId);
    }
    catch { sendJson(res, 503, { error: 'teammate tasks unavailable' }); return true; }
    finally { if (timer !== undefined) clearTimeout(timer); }
    sendJson(res, 200, body);
    return true;
  };
}
export const handleFleetTeammateTasksApi = createFleetTeammateTasksApi();
