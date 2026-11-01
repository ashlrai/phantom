import type { SelfUpdateLastApply } from '../../../../core/verse/self-update-last.js';
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

export function lastApplyOf(status: unknown): SelfUpdateLastApply | null {
  if (!status || typeof status !== 'object' || !('lastApply' in status)) return null;
  const r = status.lastApply;
  if (!r || typeof r !== 'object') return null;
  const v = r as Record<string, unknown>;
  if (!['updated', 'already-current', 'refused', 'failed'].includes(v.outcome as string)
    || !(v.reason === null || typeof v.reason === 'string')
    || ![v.startedAt, v.finishedAt].every((d) => typeof d === 'string' && Number.isFinite(Date.parse(d)))
    || ![v.fromCommit, v.toCommit].every((c) => c === null || (typeof c === 'string' && /^[a-f0-9]{7,64}$/.test(c)))
    || typeof v.restartRequired !== 'boolean' || !['sidecar-supervised', 'manual'].includes(v.restartMode as string)) return null;
  return r as SelfUpdateLastApply;
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

  const last = lastApplyOf(status);
  if (last) {
    const processHeadSha = (status as { processHeadSha?: unknown }).processHeadSha;
    const processSha = typeof processHeadSha === 'string' ? processHeadSha : null;
    let value = `${last.outcome} ${relative(last.finishedAt, now)}`;
    if ((last.outcome === 'refused' || last.outcome === 'failed') && last.reason) value += ` · ${last.reason}`;
    if (last.outcome === 'updated' && last.toCommit) value += ` · to ${last.toCommit.slice(0, 7)}`;
    if (last.restartRequired && last.fromCommit !== null && (processSha ?? status.headSha) === last.fromCommit) value += ' · restart needed';
    rows.push({ label: 'Last update', value });
  }

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
