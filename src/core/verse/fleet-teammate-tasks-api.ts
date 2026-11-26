import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listTeammateTasks, teammateTaskLedgerMatch,
  TEAMMATE_TASK_KINDS, TEAMMATE_TASK_PEERS, TEAMMATE_TASK_STATES,
  type TeammateTaskKind, type TeammateTaskLedgerFilter, type TeammateTaskPeer, type TeammateTaskState } from '../comms/imessage-teammate-tasks.js';
import { readFleetImessageTasks, type FleetImessageTaskReceipt } from '../../mcp/fleet-imessage-tasks.js';

const MAX_ROWS = 50;
type Raw = ReturnType<typeof listTeammateTasks>;
type RawTask = Raw['tasks'][number];
const COUNT_KEYS = ['queued', 'sending', 'pending', 'replied', 'expired', 'cancelled'] as const;

/** Queue-binding evidence reused verbatim from the fleet MCP reader (the single claim matcher). */
export interface TeammateBinding { queueBinding: FleetImessageTaskReceipt['queueBinding']; queueClaim: FleetImessageTaskReceipt['queueClaim'] }
export type TeammateBindings = ReadonlyMap<string, TeammateBinding>;
const UNAVAILABLE: TeammateBinding = { queueBinding: 'unavailable', queueClaim: null };

/**
 * Honest work state. With binding evidence: queued/sending -> ASSIGNED only for a bound ACTIVE queue claim, else
 * UNCONFIRMED (missing, conflicting, unavailable or finished-historical binding). pending -> TRANSPORT_CONFIRMED
 * (send receipt only, execution unverified) when bound-active, else UNCONFIRMED; never RUNNING.
 * replied+DONE -> REPORTED_DONE (peer-reported, never VERIFIED). replied+BLOCKED/FAILED -> BLOCKED.
 * expired -> UNKNOWN. cancelled -> CANCELLED. Without bindings (direct-call seam) the legacy label-only mapping applies.
 */
function workState(t: RawTask, b?: TeammateBinding): string {
  const active = b === undefined ? undefined : b.queueBinding === 'bound' && b.queueClaim === 'active';
  switch (t.state) {
    case 'queued': case 'sending': return active === false ? 'UNCONFIRMED' : 'ASSIGNED';
    case 'pending': return active === undefined ? 'RUNNING' : active ? 'TRANSPORT_CONFIRMED' : 'UNCONFIRMED';
    case 'replied': return t.result?.status === 'DONE' ? 'REPORTED_DONE' : 'BLOCKED';
    case 'cancelled': return 'CANCELLED';
    default: return 'UNKNOWN';
  }
}

/** Allow-list projection: token, receipt, claimKey, resource, metrics, result summary never leave this function. */
export function projectTeammateTasks(raw: Raw, nowIso: string, filter?: TeammateTaskLedgerFilter, bindings?: TeammateBindings) {
  // Counts cover the complete selected set before the presentation cap, as in the unfiltered view.
  const selected = filter === undefined ? raw.tasks : raw.tasks.filter(t => teammateTaskLedgerMatch(t, filter));
  const counts = Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as Record<typeof COUNT_KEYS[number], number>;
  for (const t of selected) counts[t.state]++;
  const sorted = [...selected].sort((a, b) => b.createdAt - a.createdAt);
  const rows = sorted.slice(0, MAX_ROWS).map(t => {
    const b = bindings === undefined ? undefined : bindings.get(t.jobId) ?? UNAVAILABLE;
    return {
      jobId: t.jobId, peer: t.peer, kind: t.kind, repo: t.repo, prRefs: [...t.prRefs],
      workState: workState(t, b), deadline: t.deadline, createdAt: new Date(t.createdAt).toISOString(),
      ...(b === undefined ? {} : { queueBinding: b.queueBinding, queueClaim: b.queueClaim, executionVerified: false as const }),
    };
  });
  const filtered = filter !== undefined && Object.keys(filter).length > 0;
  return { schema: raw.schema, asOf: nowIso, counts, rows, truncated: sorted.length > MAX_ROWS,
    ...(filtered ? { selection: filter, matched: selected.length > 0 } : {}) };
}

/** Default binding read: the MCP reader joined by exact selectors over the same snapshot; unreadable evidence is 'unavailable'. */
async function readBindings(raw: Raw, filter?: TeammateTaskLedgerFilter): Promise<TeammateBindings> {
  const runsDir = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const report = await readFleetImessageTasks({ ...(filter ?? {}), limit: Math.max(raw.tasks.length, 1) },
    { runsDir, listTasks: () => raw });
  return new Map((report.tasks ?? []).map(t => [t.jobId, { queueBinding: t.queueBinding, queueClaim: t.queueClaim }]));
}

/** Read-only: never enqueues, cancels, runs or takes the store lock. `bind` is a test seam for binding evidence. */
export function createFleetTeammateTasksApi(read: () => Raw | Promise<Raw> = () => listTeammateTasks(), now: () => Date = () => new Date(),
  bind: (raw: Raw, filter?: TeammateTaskLedgerFilter) => Promise<TeammateBindings> | TeammateBindings = readBindings): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/teammate-tasks') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const filter: TeammateTaskLedgerFilter = {};
    const seen = new Set<string>();
    let invalid = false;
    for (const [key, value] of params.entries()) {
      if (seen.has(key) || !['job', 'peer', 'state', 'kind'].includes(key)) { invalid = true; break; }
      seen.add(key);
      if (key === 'job') {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || scrubSecrets(value) !== value) { invalid = true; break; }
        filter.jobId = value;
      } else if (key === 'peer') {
        if (!(TEAMMATE_TASK_PEERS as readonly string[]).includes(value)) { invalid = true; break; }
        filter.peer = value as TeammateTaskPeer;
      } else if (key === 'state') {
        if (!(TEAMMATE_TASK_STATES as readonly string[]).includes(value)) { invalid = true; break; }
        filter.state = value as TeammateTaskState;
      } else {
        if (!(TEAMMATE_TASK_KINDS as readonly string[]).includes(value)) { invalid = true; break; }
        filter.kind = value as TeammateTaskKind;
      }
    }
    if (invalid) { sendJson(res, 400, { error: 'invalid query parameters' }); return true; }
    let body;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => read()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5_000); }),
      ]);
      if (raw.state !== 'healthy') throw new Error('unavailable');
      // A failed binding read never drops tasks: every row degrades to an unavailable, unconfirmed state.
      const bindings = await Promise.resolve().then(() => bind(raw, filter)).catch(() => new Map() as TeammateBindings);
      body = projectTeammateTasks(raw, now().toISOString(), filter, bindings);
    }
    catch { sendJson(res, 503, { error: 'teammate tasks unavailable' }); return true; }
    finally { if (timer !== undefined) clearTimeout(timer); }
    sendJson(res, 200, body);
    return true;
  };
}
export const handleFleetTeammateTasksApi = createFleetTeammateTasksApi();
