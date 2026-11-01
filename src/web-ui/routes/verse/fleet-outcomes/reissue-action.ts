import type { OutcomeCaseRow } from './fleet-outcomes-model.js';

export function reissueRequest(row: OutcomeCaseRow): { path: string; body: { id: string; lane?: string } } | null {
  if (!row.jobId || !/^RQ-PHX-[A-Z0-9]{3,40}$/.test(row.jobId) || row.prLink || row.proposalRecorded ||
      !row.endedAt || !Number.isFinite(Date.parse(row.endedAt))) return null;
  return { path: '/api/verse/outcomes/fleet-reissue', body: { id: row.jobId, ...(row.lane ? { lane: row.lane } : {}) } };
}

export function reissueText(result: { outcome?: string; newId?: string | null; reason?: string }): string {
  return result.outcome === 'written' && /^[A-Z0-9]{3,40}$/.test(result.newId ?? '')
    ? `re-issued as RQ-PHX-${result.newId}${result.reason ? ` · ${result.reason}` : ''}`
    : result.reason || 'Re-issue could not be confirmed.';
}
