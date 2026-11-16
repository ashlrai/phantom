import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
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
export function projectTeammateTasks(raw: Raw, nowIso: string) {
  const counts = Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as Record<typeof COUNT_KEYS[number], number>;
  for (const t of raw.tasks) counts[t.state]++;
  const sorted = [...raw.tasks].sort((a, b) => b.createdAt - a.createdAt);
  const rows = sorted.slice(0, MAX_ROWS).map(t => ({
    jobId: t.jobId, peer: t.peer, kind: t.kind, repo: t.repo, prRefs: [...t.prRefs],
    workState: workState(t), deadline: t.deadline, createdAt: new Date(t.createdAt).toISOString(),
  }));
  return { schema: raw.schema, asOf: nowIso, counts, rows, truncated: sorted.length > MAX_ROWS };
}

/** Read-only: never enqueues, cancels, runs or takes the store lock. */
export function createFleetTeammateTasksApi(read: () => Raw = () => listTeammateTasks(), now: () => Date = () => new Date()): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/teammate-tasks') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (new URL(req.url ?? path, 'http://localhost').search) { sendJson(res, 400, { error: 'query parameters are not supported' }); return true; }
    let body;
    try { body = projectTeammateTasks(read(), now().toISOString()); }
    catch { sendJson(res, 503, { error: 'teammate tasks unavailable' }); return true; }
    sendJson(res, 200, body);
    return true;
  };
}
export const handleFleetTeammateTasksApi = createFleetTeammateTasksApi();
