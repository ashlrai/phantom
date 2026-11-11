import { apiGet } from '../../../data/client.js';

export const COS_LIST_PATH = '/api/verse/fleet/cos/list?limit=20';

/** Mirrored desktop wire contract; deliberately independent of src/core. */
export interface CosTaskListRow {
  id: string; jobStatus: string; channel: string; needsYou: boolean;
  delivery: null | 'sending' | 'sent' | 'uncertain'; hasDraft: boolean; request: string;
}

function isRow(value: unknown): value is CosTaskListRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && /^cos-[0-9a-f]{32}$/.test(row.id)
    && typeof row.jobStatus === 'string' && /^[A-Z][A-Z_]*$/.test(row.jobStatus)
    && typeof row.channel === 'string' && row.channel.length > 0
    && typeof row.needsYou === 'boolean' && typeof row.hasDraft === 'boolean'
    && (row.delivery === null || row.delivery === 'sending' || row.delivery === 'sent' || row.delivery === 'uncertain')
    && typeof row.request === 'string' && row.request.length <= 140 && !/[\r\n\u2028\u2029]/.test(row.request);
}

export async function readCosTaskList(signal?: AbortSignal): Promise<CosTaskListRow[]> {
  const body = await apiGet<unknown>(COS_LIST_PATH, signal);
  if (!body || typeof body !== 'object' || !('tasks' in body) || !Array.isArray(body.tasks)) {
    throw new Error('The task list is unavailable.');
  }
  const seen = new Set<string>();
  return body.tasks.filter(isRow).filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
