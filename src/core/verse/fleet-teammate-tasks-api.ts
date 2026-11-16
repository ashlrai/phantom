import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { listTeammateTasks } from '../comms/imessage-teammate-tasks.js';

type TaskReport = ReturnType<typeof listTeammateTasks>;
type Task = TaskReport['tasks'][number];

function workState(task: Task) {
  switch (task.state) {
    case 'queued': return 'RECEIVED';
    case 'sending': return 'ASSIGNED';
    case 'pending': return task.receipt?.sent ? 'RUNNING' : 'ASSIGNED';
    case 'replied': return task.result?.status === 'DONE' ? 'REPORTED_DONE' : 'BLOCKED';
    case 'expired': return 'BLOCKED';
    case 'cancelled': return 'CANCELLED';
  }
}

/** Read-only projection: peer reports never establish independent verification. */
export function createFleetTeammateTasksApi(
  read: () => TaskReport | Promise<TaskReport> = () => listTeammateTasks(),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/teammate-tasks') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    if ([...params.keys()].length > 0) {
      sendJson(res, 400, { error: 'invalid query parameters' }); return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const report = await Promise.race([
        Promise.resolve().then(() => read()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5_000); }),
      ]);
      const counts = { queued: 0, sending: 0, pending: 0, replied: 0, expired: 0, cancelled: 0 };
      for (const task of report.tasks) counts[task.state]++;
      const rows = [...report.tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(task => ({
        jobId: task.jobId,
        peer: task.peer,
        kind: task.kind,
        repo: task.repo,
        prRefs: task.prRefs,
        state: task.state,
        workState: workState(task),
        deadline: task.deadline,
        createdAt: new Date(task.createdAt).toISOString(),
        attemptedAt: task.attemptedAt === undefined ? null : new Date(task.attemptedAt).toISOString(),
        receiptSent: task.receipt?.sent ?? null,
        resultStatus: task.result?.status ?? null,
        resultAt: task.result ? new Date(task.result.at).toISOString() : null,
        evidence: task.result ? 'peer-reported' : task.receipt?.sent ? 'transport-receipt' : 'none',
      }));
      sendJson(res, 200, { schema: report.schema, asOf: new Date().toISOString(), counts, rows, truncated: report.tasks.length > 30 });
    } catch { sendJson(res, 503, { error: 'teammate tasks unavailable' }); }
    finally { if (timer) clearTimeout(timer); }
    return true;
  };
}
export const handleFleetTeammateTasksApi = createFleetTeammateTasksApi();
