/** Narrowed view for GET /api/verse/fleet/control/teammate-tasks. Never throws; never guesses a state. */
export type TeammateWorkState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'REPORTED_DONE' | 'BLOCKED' | 'CANCELLED' | 'UNKNOWN';
export type TeammatePeer = 'dot' | 'instinct';
export interface TeammateTaskRow {
  jobId: string; peer: TeammatePeer; kind: string; repo: string; prRefs: number[];
  workState: TeammateWorkState; deadline: string; createdAt: string;
}
export interface TeammateTasksView {
  asOf: string;
  counts: Record<'queued' | 'sending' | 'pending' | 'replied' | 'expired' | 'cancelled', number>;
  rows: TeammateTaskRow[];
  truncated: boolean;
  /** false when any row was dropped as malformed. */
  complete: boolean;
}

const SCHEMA = 'imessage.teammate-tasks.v1';
const STATES = new Set(['RECEIVED', 'ASSIGNED', 'RUNNING', 'REPORTED_DONE', 'BLOCKED', 'CANCELLED']);
const COUNT_KEYS = ['queued', 'sending', 'pending', 'replied', 'expired', 'cancelled'] as const;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => typeof v === 'string' ? v.slice(0, 128) : '';

function narrowRow(r: unknown): TeammateTaskRow | null {
  if (!object(r)) return null;
  const jobId = str(r.jobId), createdAt = str(r.createdAt);
  if (!jobId || !createdAt || (r.peer !== 'dot' && r.peer !== 'instinct')) return null;
  const workState = typeof r.workState === 'string' && STATES.has(r.workState) ? r.workState as TeammateWorkState : 'UNKNOWN';
  const prRefs = Array.isArray(r.prRefs) ? r.prRefs.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [];
  return { jobId, peer: r.peer, kind: str(r.kind), repo: str(r.repo), prRefs, workState, deadline: str(r.deadline), createdAt };
}

export function narrowTeammateTasks(raw: unknown): TeammateTasksView | null {
  if (!object(raw) || raw.schema !== SCHEMA || !Array.isArray(raw.rows) || !object(raw.counts)) return null;
  const c = raw.counts;
  const counts = {} as TeammateTasksView['counts'];
  for (const key of COUNT_KEYS) {
    const v = c[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
    counts[key] = v;
  }
  const rows = raw.rows.flatMap((r) => { const row = narrowRow(r); return row ? [row] : []; });
  return { asOf: str(raw.asOf), counts, rows, truncated: raw.truncated === true, complete: rows.length === raw.rows.length };
}
