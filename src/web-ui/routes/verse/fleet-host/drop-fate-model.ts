import type { DropJobFatesV1 } from '../../../../core/fleet/drop-job-fate.js';

export function narrowDropFates(value: unknown): DropJobFatesV1 | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as DropJobFatesV1;
  if (data.v !== 1 || !Array.isArray(data.fates) || !data.fates.every(row => row && typeof row.id === 'string'
    && (row.fate === 'ingested' || row.fate === 'rejected') && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && (row.lane === null || typeof row.lane === 'string') && (row.tier === null || typeof row.tier === 'string')
    && (row.reason === null || typeof row.reason === 'string'))) return null;
  return data;
}


export function fateRows(data: unknown, nowMs: number) {
  const report = narrowDropFates(data);
  if (!report) return null;
  const accepted = report.fates.filter(row => row.fate === 'ingested').length;
  return {
    summary: `last sweep: ${accepted} accepted, ${report.fates.length - accepted} rejected`,
    rows: report.fates.map(row => {
      const seconds = Math.max(0, Math.floor((nowMs - Date.parse(row.at)) / 1000));
      const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
      const rejected = row.fate === 'rejected';
      const detail = rejected ? row.reason : [row.lane, row.tier].filter(Boolean).join(' ');
      return { id: `${row.id}-${row.fate}-${row.at}`, text: `${row.id} ${rejected ? 'rejected' : 'accepted'} ${age} ago${detail ? ` · ${detail}` : ''}`, tone: rejected ? 'bad' : 'ok' };
    }),
  };
}
