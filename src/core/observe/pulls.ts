/**
 * Pull-request headlines from a gh-shaped export. Rates stay null when the
 * export is truncated or a merged pull has no outcome label.
 */
import type { RepoHeadline } from './types.js';

export interface PullFact {
  repo: string;
  number: number;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  queueWaitSeconds: number | null;
  ciDurationSeconds: number | null;
  reverted: boolean | null;
  fixForward: boolean | null;
  failedRelease: boolean | null;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function direction(earlier: number, later: number): 'up' | 'down' | 'flat' {
  if (later > earlier) return 'up';
  if (later < earlier) return 'down';
  return 'flat';
}

export function headlinesFor(pulls: readonly PullFact[], nowMs: number, windowDays: number, complete: boolean): RepoHeadline[] {
  const start = nowMs - windowDays * 86_400_000;
  const mid = start + (windowDays * 86_400_000) / 2;
  const repos = [...new Set(pulls.map((pull) => pull.repo))].filter((repo) => REPO.test(repo) && !repo.split('/').some((part) => part === '.' || part === '..'));
  return repos.sort().map((repo) => {
    const rows = pulls.filter((pull) => pull.repo === repo);
    if (!complete) {
      return empty(repo, 'The pull list is truncated, so rates are unknown', windowDays);
    }
    const opened = rows.filter((pull) => {
      const at = Date.parse(pull.createdAt);
      return Number.isFinite(at) && at >= start && at <= nowMs;
    }).length;
    const mergedRows = rows.filter((pull) => {
      const at = pull.mergedAt ? Date.parse(pull.mergedAt) : NaN;
      return pull.state === 'merged' && Number.isFinite(at) && at >= start && at <= nowMs;
    });
    const failed = rows.filter((pull) => {
      const at = pull.closedAt ? Date.parse(pull.closedAt) : NaN;
      return pull.state === 'closed' && pull.mergedAt === null && Number.isFinite(at) && at >= start && at <= nowMs;
    }).length;
    const mergeHours = mergedRows.flatMap((pull) => {
      const created = Date.parse(pull.createdAt);
      const merged = Date.parse(pull.mergedAt ?? '');
      return Number.isFinite(created) && Number.isFinite(merged) && merged >= created ? [(merged - created) / 3_600_000] : [];
    });
    const queue = mergedRows.flatMap((pull) => pull.queueWaitSeconds === null ? [] : [pull.queueWaitSeconds / 3600]);
    const ci = rows.flatMap((pull) => pull.ciDurationSeconds === null ? [] : [pull.ciDurationSeconds / 3600]);
    const classified = mergedRows.every((pull) => pull.reverted !== null && pull.fixForward !== null && pull.failedRelease !== null);
    const changeFailures = classified ? mergedRows.filter((pull) => pull.reverted || pull.fixForward || pull.failedRelease).length : null;
    const days: RepoHeadline['trend']['days'] = [];
    for (let cursor = Date.parse(`${dayKey(start)}T00:00:00.000Z`); cursor <= nowMs; cursor += 86_400_000) {
      const key = dayKey(cursor);
      const dayMerges = mergedRows.filter((pull) => dayKey(Date.parse(pull.mergedAt ?? '')) === key);
      days.push({
        date: key,
        merged: dayMerges.length,
        changeFailures: classified ? dayMerges.filter((pull) => pull.reverted || pull.fixForward || pull.failedRelease).length : null,
      });
    }
    const earlier = mergedRows.filter((pull) => Date.parse(pull.mergedAt ?? '') < mid).length;
    const later = mergedRows.length - earlier;
    let cfrTrend: RepoHeadline['trend']['changeFailureRate'] = 'unknown';
    if (classified && mergedRows.length > 0) {
      const earlierFail = mergedRows.filter((pull) => Date.parse(pull.mergedAt ?? '') < mid && (pull.reverted || pull.fixForward || pull.failedRelease)).length;
      const laterFail = (changeFailures ?? 0) - earlierFail;
      const earlierRate = earlier === 0 ? null : earlierFail / earlier;
      const laterRate = later === 0 ? null : laterFail / later;
      if (earlierRate !== null && laterRate !== null) cfrTrend = direction(earlierRate, laterRate);
    }
    return {
      repo,
      state: 'live',
      reason: null,
      opened,
      merged: mergedRows.length,
      failed,
      mergedPerDay: mergedRows.length / windowDays,
      timeToMergeHours: median(mergeHours),
      queueWaitHours: median(queue),
      ciDurationHours: median(ci),
      changeFailureRate: classified && mergedRows.length > 0 ? (changeFailures ?? 0) / mergedRows.length : null,
      trend: { mergedPerDay: direction(earlier, later), changeFailureRate: cfrTrend, days },
    };
  });
}

function empty(repo: string, reason: string, _windowDays: number): RepoHeadline {
  return {
    repo, state: 'unknown', reason, opened: null, merged: null, failed: null, mergedPerDay: null,
    timeToMergeHours: null, queueWaitHours: null, ciDurationHours: null, changeFailureRate: null,
    trend: { mergedPerDay: 'unknown', changeFailureRate: 'unknown', days: [] },
  };
}

export function parsePullExport(raw: unknown): { pulls: PullFact[]; complete: boolean } | null {
  const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const rows = Array.isArray(raw) ? raw : Array.isArray(body?.['pulls']) ? body!['pulls'] as unknown[] : null;
  if (!rows) return null;
  const pulls: PullFact[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const repo = typeof item['repo'] === 'string' ? item['repo'] : '';
    const number = item['number'];
    const state = item['state'] === 'merged' || item['state'] === 'MERGED' ? 'merged'
      : item['state'] === 'closed' || item['state'] === 'CLOSED' ? 'closed'
      : item['state'] === 'open' || item['state'] === 'OPEN' ? 'open' : null;
    const createdAt = typeof item['createdAt'] === 'string' ? item['createdAt'] : '';
    if (!REPO.test(repo) || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || !state || !Number.isFinite(Date.parse(createdAt))) continue;
    const optionalTime = (key: string) => typeof item[key] === 'string' && Number.isFinite(Date.parse(item[key] as string)) ? item[key] as string : null;
    const optionalBool = (key: string) => typeof item[key] === 'boolean' ? item[key] as boolean : null;
    const optionalNum = (key: string) => typeof item[key] === 'number' && Number.isFinite(item[key] as number) && (item[key] as number) >= 0 ? item[key] as number : null;
    pulls.push({
      repo, number, state, createdAt,
      mergedAt: optionalTime('mergedAt'),
      closedAt: optionalTime('closedAt'),
      queueWaitSeconds: optionalNum('queueWaitSeconds'),
      ciDurationSeconds: optionalNum('ciDurationSeconds'),
      reverted: optionalBool('reverted'),
      fixForward: optionalBool('fixForward'),
      failedRelease: optionalBool('failedRelease'),
    });
  }
  return { pulls, complete: body?.['complete'] !== false && body?.['truncated'] !== true };
}
