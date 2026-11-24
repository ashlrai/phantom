/**
 * Pure reading of the work log (`worklog.v3`, GET /api/worklog?hours=24, `phm worklog --hours 24 --json`) for Home's
 * Work log card: the events as drawn, the sentence over them, and where each kind's events fall on the report's own
 * hours. Nothing is estimated: an event with no readable time is listed without a place on the day, a link is only
 * ever a GitHub pull request address, and a source the report could not read is named instead of counted as quiet.
 */
import { WORKLOG_KINDS, type WorklogKind, type WorklogReport } from '../../../../core/fleet/worklog.js';

export interface DayEvent {
  key: string;
  /** Epoch milliseconds, or null when the row's stamp cannot be read. */
  atMs: number | null;
  kind: WorklogKind;
  text: string;
  /** A checked pull request address, or null. Never the payload's URL as given. */
  href: string | null;
  job: string | null;
  lane: string | null;
  /** How many consecutive events of one job this line stands for; at least 1. */
  count: number;
}
/** The stretch of time the report covers, as far as this window can know it. */
export interface DayWindow { startMs: number; endMs: number }
/** One kind's row of the day. `cells` are equal slices of the window, oldest first, each holding its event count. */
export interface KindRow { kind: WorklogKind; label: string; events: number; lastMs: number | null; cells: number[]; peak: number }

/** How many slices the day is cut into: half hours when the report covers 24 hours. */
export const DAY_CELLS = 48;
export const KIND_LABEL: Record<WorklogKind, string> = { merged: 'Merged', launched: 'Launched', finished: 'Finished', empty: 'No change', leader: 'Leader', incident: 'Incident' };
const PULL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Only a `worklog.v3` payload with rows is a report; anything else (an older server, an error body) is not. */
export function worklogOf(data: unknown): WorklogReport | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<WorklogReport>;
  return report.schema === 'worklog.v3' && Array.isArray(report.rows) ? report as WorklogReport : null;
}

/** The rows in the order given (the report and the Home summary both list newest first). A row without a known kind or any words is left out. */
export function dayEvents(rows: readonly unknown[]): DayEvent[] {
  const events: DayEvent[] = [];
  for (const item of rows) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const kind = row['kind'], words = text(row['text']);
    if (words === null || !(WORKLOG_KINDS as readonly unknown[]).includes(kind)) continue;
    const at = typeof row['at'] === 'string' ? Date.parse(row['at']) : NaN;
    const url = text(row['url']), count = row['count'];
    events.push({
      key: `${events.length} ${String(row['at'])} ${words}`, atMs: Number.isFinite(at) ? at : null, kind: kind as WorklogKind, text: words,
      href: url !== null && PULL_RE.test(url) ? url : null, job: text(row['job']), lane: text(row['lane']),
      count: typeof count === 'number' && Number.isInteger(count) && count > 1 ? count : 1,
    });
  }
  return events;
}

/** The report's hours ending when this window received it. Null when either is unknown, so no day is drawn against a guessed one. */
export function dayWindow(hours: unknown, readMs: unknown): DayWindow | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || typeof readMs !== 'number' || !Number.isFinite(readMs)) return null;
  return { startMs: readMs - hours * 3_600_000, endMs: readMs };
}

/** One row per kind that has an event, in the work log's own kind order. An event outside the window is counted but has no cell. */
export function kindRows(events: readonly DayEvent[], window: DayWindow | null): KindRow[] {
  const rows: KindRow[] = [];
  for (const kind of WORKLOG_KINDS) {
    const mine = events.filter(event => event.kind === kind);
    if (!mine.length) continue;
    const cells = new Array<number>(window ? DAY_CELLS : 0).fill(0);
    let lastMs: number | null = null, total = 0;
    for (const event of mine) {
      total += event.count;
      if (event.atMs === null) continue;
      if (lastMs === null || event.atMs > lastMs) lastMs = event.atMs;
      if (!window) continue;
      const share = (event.atMs - window.startMs) / (window.endMs - window.startMs);
      if (share >= 0 && share <= 1) cells[Math.min(DAY_CELLS - 1, Math.floor(share * DAY_CELLS))]! += event.count;
    }
    rows.push({ kind, label: KIND_LABEL[kind], events: total, lastMs, cells, peak: Math.max(0, ...cells) });
  }
  return rows;
}

/** "86 events in the last 24 hours: 12 merged, 40 launched, 1 incident." Counts only what the report lists. */
export function daySentence(rows: readonly KindRow[], hours: number | null): string {
  const span = hours === null ? 'this read' : `the last ${hours === 1 ? 'hour' : `${hours} hours`}`;
  const total = rows.reduce((sum, row) => sum + row.events, 0);
  if (total === 0) return hours === null ? 'No work recorded.' : `No work recorded in ${span}.`;
  return `${total} ${total === 1 ? 'event' : 'events'} in ${span}: ${rows.map(row => `${row.events} ${row.label.toLowerCase()}`).join(', ')}.`;
}

/** The reasons of every source the report could not read. Their events are absent from the card, not zero. */
export function unreadSources(report: WorklogReport): string[] {
  const sources: unknown = report.sources;
  if (sources === null || typeof sources !== 'object') return [];
  return Object.values(sources as Record<string, unknown>).flatMap(source => {
    const row = source as { state?: unknown; reason?: unknown } | null;
    return row && row.state === 'unknown' && typeof row.reason === 'string' ? [row.reason] : [];
  });
}

/** How long one cell of the day covers, in words: "30 min", "1 h". */
export function cellWords(hours: number): string {
  const minutes = Math.round((hours * 60) / DAY_CELLS);
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}
