import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatRelative } from '../autonomy/format.js';

/**
 * Local shape of GET /api/verse/fleet/recheck?history=N → `{ history: { rows, skipped, missing } }`.
 * Declared here on purpose: the web bundle must not import src/core. Every
 * field is validated in deriveRecheckHistory, never trusted.
 */
export interface RecheckHistoryResp {
  history?: { rows?: unknown; skipped?: unknown; missing?: unknown };
}

/** `null` = the route (or its history) is absent (404) on this build. */
export const recheckHistoryQuery: QueryDef<RecheckHistoryResp | null> = {
  key: 'verse-fleet-recheck-history',
  async fetch(signal) {
    try { return await apiGet<RecheckHistoryResp>('/api/verse/fleet/recheck?history=20', signal); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export interface RecheckHistoryView {
  held: string;
  changes: { asOf: string; text: string }[];
  note: string | null;
}

const SECTIONS = ['runtime', 'claims', 'bridge', 'task'] as const;
const STATES = ['VERIFIED', 'UNKNOWN', 'BLOCKED'];
const MAX_CHANGES = 5;

interface Row { asOf: string; ms: number; overall: string; sections: Record<(typeof SECTIONS)[number], string>; }

/** Anything outside the three known states prints as "unreadable". */
const label = (state: string): string => (STATES.includes(state) ? state : 'unreadable');

function parseRow(raw: unknown): Row | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.asOf !== 'string' || typeof r.overall !== 'string') return null;
  const ms = Date.parse(r.asOf);
  if (Number.isNaN(ms) || !r.sections || typeof r.sections !== 'object') return null;
  const secs = r.sections as Record<string, unknown>;
  const sections = {} as Row['sections'];
  for (const name of SECTIONS) {
    const s = secs[name];
    const state = s && typeof s === 'object' ? (s as { state?: unknown }).state : undefined;
    if (typeof state !== 'string') return null;
    sections[name] = state;
  }
  return { asOf: r.asOf, ms, overall: r.overall, sections };
}

function duration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return 'under 1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (ms: number): string => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function deriveRecheckHistory(resp: RecheckHistoryResp | null | undefined, now: number): RecheckHistoryView {
  const hist = resp && typeof resp === 'object' ? resp.history : undefined;
  if (!hist || typeof hist !== 'object') return { held: 'Recheck history unreadable', changes: [], note: null };

  const rawRows = Array.isArray(hist.rows) ? hist.rows : [];
  const rows: Row[] = [];
  let bad = 0;
  for (const raw of rawRows) { const row = parseRow(raw); if (row) rows.push(row); else bad += 1; }
  const serverSkipped = typeof hist.skipped === 'number' && Number.isFinite(hist.skipped) && hist.skipped > 0 ? Math.floor(hist.skipped) : 0;
  const skipped = bad + serverSkipped;
  const note = skipped > 0 ? `${skipped} unreadable rows skipped` : null;

  if (rows.length === 0) {
    return { held: hist.missing === true && rawRows.length === 0 ? 'No recorded rechecks yet' : 'Recheck history unreadable', changes: [], note };
  }

  // Rows are newest-first; the run is the leading rows sharing rows[0].overall.
  let run = 1;
  while (run < rows.length && rows[run]!.overall === rows[0]!.overall) run += 1;
  const since = rows[run - 1]!;
  const longer = run === rows.length ? ' or longer' : '';
  const held = `${label(rows[0]!.overall)} for ${duration(now - since.ms)} (since ${clock(since.ms)}, ${run} check${run === 1 ? '' : 's'})${longer}`;

  const changes: RecheckHistoryView['changes'] = [];
  for (let i = 0; i + 1 < rows.length && changes.length < MAX_CHANGES; i += 1) {
    const cur = rows[i]!; const prev = rows[i + 1]!;
    const parts: string[] = [];
    for (const name of SECTIONS) {
      if (cur.sections[name] !== prev.sections[name]) parts.push(`${name} ${label(prev.sections[name])} → ${label(cur.sections[name])}`);
    }
    if (cur.overall !== prev.overall) parts.push(`overall ${label(prev.overall)} → ${label(cur.overall)}`);
    if (parts.length > 0) changes.push({ asOf: cur.asOf, text: `${parts.join(', ')} · ${formatRelative(cur.asOf, now)}` });
  }
  return { held, changes, note };
}
