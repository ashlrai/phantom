/**
 * Pure reading of the fleet shipped feed (`fleet.shipped.v1`, GET /api/verse/shipped?since=24h) for Home's
 * Shipped today card: the rows as drawn, the split by repository, the sentence over the list and where each
 * pull request's time open falls on the feed's own 24 hour window. Nothing is estimated: a time the feed does
 * not hold is null here and "unknown" on screen, and counts come only from the pull requests listed.
 */
import type { FleetShippedReport } from '../../../../core/fleet/shipped.js';

export interface ShippedRow {
  key: string;
  /** Full `owner/name`, the value the repository filter matches. */
  repo: string;
  /** The name without the owner, as the row and the filter show it. */
  label: string;
  number: number;
  title: string;
  href: string;
  /** Epoch milliseconds, or null when the feed's stamp cannot be read. */
  mergedMs: number | null;
  lane: string | null;
  jobId: string | null;
  openSeconds: number | null;
}
export interface RepoPart { repo: string; label: string; merged: number; share: number }
/** The feed's window, taken from its own `since` and `generatedAt`. */
export interface ShippedWindow { startMs: number; endMs: number }
/** Shares of the window, 0 to 1. `from` is null when the time open is unknown; `clipped` when it opened before the window. */
export interface RowSpan { from: number | null; to: number; clipped: boolean }

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const stamp = (value: unknown): number | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
export const repoLabel = (repo: string): string => repo.slice(repo.indexOf('/') + 1) || repo;

/** Only a `fleet.shipped.v1` payload with a list is a report; anything else (an older server, an error body) is not. */
export function shippedOf(data: unknown): FleetShippedReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<FleetShippedReport>;
  return report.schema === 'fleet.shipped.v1' && Array.isArray(report.items) ? report as FleetShippedReport : null;
}

/** The feed's rows in its own order (newest first). A row without a repository or a number cannot be linked and is left out. */
export function shippedRows(report: FleetShippedReport): ShippedRow[] {
  const rows: ShippedRow[] = [];
  for (const item of report.items as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const pr = item as Record<string, unknown>;
    const repo = text(pr['repo']);
    const number = pr['number'];
    if (repo === null || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
    const open = pr['openToMergeSeconds'];
    rows.push({
      key: `${repo}#${number}`, repo, label: repoLabel(repo), number, title: text(pr['title']) ?? 'Untitled',
      // Built from the two checked parts, never from a URL in the payload.
      href: `https://github.com/${repo}/pull/${number}`,
      mergedMs: stamp(pr['mergedAt']), lane: text(pr['lane']), jobId: text(pr['jobId']),
      openSeconds: typeof open === 'number' && Number.isFinite(open) && open >= 0 ? open : null,
    });
  }
  return rows;
}

/** Repositories that merged, most first then by name, each with its share of the rows listed. */
export function repoParts(rows: readonly ShippedRow[]): RepoPart[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
  return [...counts].map(([repo, merged]) => ({ repo, label: repoLabel(repo), merged, share: merged / rows.length }))
    .sort((a, b) => b.merged - a.merged || a.label.localeCompare(b.label));
}

/** "40 seconds", "14 min", "3 h 12 min", "2 d 4 h": two units at most. */
export function openWords(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** The row that stayed open longest, among rows that give a time open. */
export function slowestRow(rows: readonly ShippedRow[]): ShippedRow | null {
  let slowest: ShippedRow | null = null;
  for (const row of rows) if (row.openSeconds !== null && (slowest === null || row.openSeconds > slowest.openSeconds!)) slowest = row;
  return slowest;
}

/** The feed's own window. Null when either end is unreadable, so no line is drawn against a guessed one. */
export function shippedWindow(report: FleetShippedReport): ShippedWindow | null {
  const startMs = stamp(report.since), endMs = stamp(report.generatedAt);
  return startMs !== null && endMs !== null && endMs > startMs ? { startMs, endMs } : null;
}

/** Where a row sits on the window: merged at `to`, open from `from`. A merge outside the window has no place on it. */
export function rowSpan(row: ShippedRow, window: ShippedWindow): RowSpan | null {
  if (row.mergedMs === null) return null;
  const width = window.endMs - window.startMs;
  const to = (row.mergedMs - window.startMs) / width;
  if (to < 0 || to > 1) return null;
  if (row.openSeconds === null) return { from: null, to, clipped: false };
  const from = to - (row.openSeconds * 1000) / width;
  return { from: Math.max(0, from), to, clipped: from < 0 };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The sentences over the list. Totals come from the report and are stated only when it is complete; an
 * incomplete feed counts what is listed and says the rest is unknown.
 */
export function shippedSummary(report: FleetShippedReport, rows: readonly ShippedRow[]): { headline: string; pace: string | null } {
  const repos = repoParts(rows).length;
  const totals = (report.totals ?? {}) as Partial<FleetShippedReport['totals']>;
  const merged = typeof totals.merged === 'number' ? totals.merged : null;
  if (report.complete !== true || merged === null) {
    return { headline: `${count(rows.length, 'merged pull request')} listed. Some results are unavailable, so totals are unknown.`, pace: null };
  }
  if (merged === 0) return { headline: 'Nothing merged in the last 24 hours.', pace: null };
  const rate = typeof totals.mergedPerHour === 'number' ? `, ${totals.mergedPerHour.toFixed(1)} per hour` : '';
  const headline = `${merged} merged${repos > 1 ? ` across ${repos} repositories` : repos === 1 ? ` in ${repoLabel(rows[0]!.repo)}` : ''}${rate}.`;
  const median = typeof totals.medianOpenToMergeSeconds === 'number' ? totals.medianOpenToMergeSeconds : null;
  const slowest = slowestRow(rows);
  const pace = `Median open to merge: ${median === null ? 'unknown' : openWords(median)}.`
    + (slowest !== null && rows.length > 1 ? ` Longest open: ${slowest.label} #${slowest.number}, ${openWords(slowest.openSeconds!)}.` : '');
  return { headline, pace };
}
