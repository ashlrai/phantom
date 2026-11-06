import type { IngestedRow } from './drop-job-fate.js';

// eslint-disable-next-line no-control-regex -- ledger cells must stay a single printable line.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const BRIDGE = /^bridge\(([^)]+)\)/;
/** The planner never sees more than this many in-flight rows. */
const CAP = 80;

/**
 * Lines for the IN FLIGHT brief section: RQ-PHX jobs ingested inside the
 * window that no `bridge(<id>)` subject on origin/master has merged yet, so a
 * planner pass can see which topics are already taken. Newest first.
 */
export function inflightBriefLines(rows: IngestedRow[], mergedSubjects: string[], nowMs: number, windowHours = 48): string[] {
  const merged = new Set<string>();
  for (const subject of mergedSubjects) {
    const id = BRIDGE.exec(subject)?.[1];
    if (id !== undefined) merged.add(id);
  }
  const windowMs = windowHours * 3_600_000;
  const latest = new Map<string, { row: IngestedRow; atMs: number }>();
  for (const row of rows) {
    const atMs = Date.parse(row.at.replace(' ', 'T'));
    if (!Number.isFinite(atMs) || Math.abs(nowMs - atMs) > windowMs || merged.has(row.id)) continue;
    const prior = latest.get(row.id);
    if (prior === undefined || atMs > prior.atMs) latest.set(row.id, { row, atMs });
  }
  const flying = [...latest.values()].sort((a, b) => b.atMs - a.atMs || a.row.id.localeCompare(b.row.id));
  if (!flying.length) return [`(none: every job ingested in the last ${windowHours}h has merged)`];
  const render = ({ row, atMs }: { row: IngestedRow; atMs: number }): string => {
    const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
    const age = minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
    const lane = row.lane.replace(CONTROL, '') || '-';
    const tier = row.tier.replace(CONTROL, '') || '-';
    return `${row.id} ${lane} ${tier} ${age} ${row.title.replace(CONTROL, '').slice(0, 80)}`;
  };
  const out = flying.slice(0, CAP).map(render);
  if (flying.length > CAP) out.push(`(${flying.length - CAP} more in flight not shown)`);
  return out;
}
