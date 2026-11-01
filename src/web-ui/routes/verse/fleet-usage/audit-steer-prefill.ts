import type { AuditLane } from './usage-audit-queries.js';

const excerpt = (value: string, limit: number): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
};

export function auditSteerVisible(row: AuditLane): boolean {
  return row.classification === 'incident' || row.classification === 'idle';
}

export function auditSteerPrefill(row: AuditLane, nowIso: string): string {
  const duration = row.observedMinutes === null ? '' : ` for ${row.observedMinutes} min`;
  const percent = row.pctUsedFirst === null || row.pctUsedLast === null
    ? '' : ` (${row.pctUsedFirst}% -> ${row.pctUsedLast}%)`;
  return `Lane ${excerpt(row.lane, 100)}: ${row.classification}${duration}${percent}. `
    + `Reason: ${excerpt(row.reason, 120)}. Suggested: ${excerpt(row.nextAction, 120)}. `
    + `Decide whether this lane keeps its slots or hands them to another lane. As of ${excerpt(nowIso, 40)}.`;
}
