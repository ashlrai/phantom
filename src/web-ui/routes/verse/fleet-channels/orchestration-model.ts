/** Narrow read-only journal projection. No receipt keys or transport metadata reach the card. */
export interface OrchestrationAssignment { job: string; specialist: string; assignedAt: string }
export interface OrchestrationRow extends OrchestrationAssignment { status: 'reserved' | 'admitted' | 'complete' }
export interface OrchestrationView {
  header: string;
  counts: { reserved: number; admitted: number; complete: number };
  unresolved: OrchestrationAssignment[];
  rows: OrchestrationRow[];
  truncated: boolean;
  source: 'missing' | 'ok';
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const label = (v: unknown): v is string => typeof v === 'string' && v.length <= 64;
function assignment(v: unknown): v is OrchestrationAssignment {
  return object(v) && label(v.job) && label(v.specialist) && typeof v.assignedAt === 'string'
    && v.assignedAt.length <= 64 && Number.isFinite(Date.parse(v.assignedAt));
}
function row(v: unknown): v is OrchestrationRow {
  return assignment(v) && 'status' in v && (v.status === 'reserved' || v.status === 'admitted' || v.status === 'complete');
}
const project = ({ job, specialist, assignedAt }: OrchestrationAssignment): OrchestrationAssignment => ({ job, specialist, assignedAt });

export function toOrchestrationView(payload: unknown): OrchestrationView | null {
  if (!object(payload) || payload.schemaVersion !== 1 || payload.authority !== 'none'
    || (payload.source !== 'missing' && payload.source !== 'ok') || !count(payload.total)
    || typeof payload.truncated !== 'boolean' || !object(payload.counts)
    || !count(payload.counts.reserved) || !count(payload.counts.admitted) || !count(payload.counts.complete)
    || !Array.isArray(payload.unresolved) || !payload.unresolved.every(assignment)
    || !Array.isArray(payload.receipts) || !payload.receipts.every(row)) return null;
  const { reserved, admitted, complete } = payload.counts;
  return {
    header: payload.source === 'missing' ? 'No orchestration journal yet' : `${reserved} reserved · ${admitted} admitted · ${complete} complete`,
    counts: { reserved, admitted, complete }, source: payload.source, truncated: payload.truncated,
    unresolved: payload.unresolved.map(project),
    rows: payload.receipts.slice(0, 25).map(r => ({ ...project(r), status: r.status })),
  };
}
