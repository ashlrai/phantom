import type { ServerObservation } from './update-status-queries.js';

export interface AboutUpdateLines {
  tone: 'current' | 'behind' | 'unknown' | 'notInBuild';
  headline: string;
  rows: Array<{ label: string; value: string; mono?: boolean }>;
}

function duration(seconds: number): string {
  const units = [
    [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second'],
  ] as const;
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const [size, name] = units.find(([size]) => wholeSeconds >= size) ?? units[units.length - 1]!;
  const count = Math.floor(wholeSeconds / size);
  return `${count} ${name}${count === 1 ? '' : 's'}`;
}

function relative(iso: string, now: number): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  return seconds < 0 ? `in ${duration(-seconds)}` : `${duration(seconds)} ago`;
}

export function aboutUpdateLines(status: ServerObservation, now: number): AboutUpdateLines {
  if (!status) return { tone: 'unknown', headline: 'Self-update status unavailable.', rows: [] };
  if ('kind' in status) return { tone: 'notInBuild', headline: 'Self-update status is not in this build.', rows: [] };

  const rows: AboutUpdateLines['rows'] = [];
  if (status.headSha !== null) rows.push({ label: 'Running commit', value: status.headSha.slice(0, 7), mono: true });
  if (status.headAt !== null) rows.push({ label: 'Committed', value: relative(status.headAt, now) });
  if (status.originSha !== null) rows.push({ label: 'Origin', value: status.originSha.slice(0, 7), mono: true });
  if (status.lastFetchAt !== null) rows.push({ label: 'Last fetch', value: relative(status.lastFetchAt, now) });
  if (status.uptimeSeconds !== null) rows.push({ label: 'Process up', value: duration(status.uptimeSeconds) });

  const origin = status.branch ? `origin/${status.branch}` : 'origin';
  if (status.sourceState === 'unavailable') return { tone: 'unknown', headline: 'Self-update status unavailable.', rows };
  if (status.behind !== null && status.behind > 0) {
    const readiness = status.dirty ? 'Needs a manual update (local changes)'
      : status.canFastForward ? 'Fast-forward ready' : 'Fast-forward unavailable';
    return { tone: 'behind', headline: `${status.behind} ${status.behind === 1 ? 'commit' : 'commits'} behind ${origin} · ${readiness}`, rows };
  }
  if (status.behind === 0 && status.dirty === false) return { tone: 'current', headline: `Up to date with ${origin}`, rows };
  if (status.behind === 0 && status.dirty === true) return { tone: 'unknown', headline: `No commits behind ${origin} · local changes present`, rows };
  return { tone: 'unknown', headline: 'Self-update status unavailable.', rows };
}
