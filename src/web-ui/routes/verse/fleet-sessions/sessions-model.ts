/**
 * The Sessions pane's read: GET /api/verse/fleet/control/live-sessions, the
 * same fleet.live-sessions.v1 list `phm sessions --json` prints. Narrowing is
 * defensive: a malformed row is dropped, a malformed field reads "unknown".
 */
import { SESSION_FIELDS, type LiveSessionRow, type LiveSessionsV1, type SessionField } from '../../../../core/fleet/live-sessions.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const LIVE_SESSIONS_API = '/api/verse/fleet/control/live-sessions';
/** The server reads at most once per 5 s; the pane asks every 10 s while visible. */
export const SESSIONS_POLL_MS = 10_000;
const MAX_ROWS = 500, MAX_TEXT = 200;

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const PR = /^https:\/\/github\.com\/\S+$/;

function narrowRow(raw: unknown): LiveSessionRow | null {
  const job = object(raw) ? text(raw.job) : null;
  if (!object(raw) || !job) return null;
  const why = object(raw.unknown) ? raw.unknown : {};
  const unknown: Partial<Record<SessionField, string>> = {};
  for (const field of SESSION_FIELDS) { const reason = text(why[field]); if (reason) unknown[field] = reason; }
  const prUrl = text(raw.prUrl);
  return {
    job, lane: text(raw.lane) ?? 'unknown', model: text(raw.model) ?? 'unknown', repo: text(raw.repo) ?? 'unknown',
    tier: text(raw.tier) ?? 'unknown', status: text(raw.status) ?? 'unknown', startedAt: time(raw.startedAt), ageSeconds: count(raw.ageSeconds),
    lastOutputAt: time(raw.lastOutputAt), lastOutputAgeSeconds: count(raw.lastOutputAgeSeconds), quiet: bool(raw.quiet),
    prUrl: prUrl && PR.test(prUrl) ? prUrl : null, computer: text(raw.computer) ?? 'unknown', thisComputer: bool(raw.thisComputer), unknown,
  };
}

/** Null when this is not a live-sessions list. */
export function narrowLiveSessions(raw: unknown): LiveSessionsV1 | null {
  if (!object(raw) || raw.schema !== 'fleet.live-sessions.v1' || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.slice(0, MAX_ROWS).map(narrowRow).filter((row): row is LiveSessionRow => row !== null);
  const filter = object(raw.filter) ? raw.filter : {};
  return {
    schema: 'fleet.live-sessions.v1', generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(),
    quietAfterMinutes: count(raw.quietAfterMinutes) ?? 10, filter: { lane: text(filter.lane), repo: text(filter.repo) },
    counts: { sessions: sessions.length, quiet: sessions.filter(row => row.quiet).length,
      lanes: new Set(sessions.map(row => row.lane)).size, otherComputers: sessions.filter(row => row.thisComputer === false).length },
    sessions, gaps: Array.isArray(raw.gaps) ? raw.gaps.map(text).filter((gap): gap is string => gap !== null).slice(0, 20) : [],
  };
}

export const liveSessionsQuery: QueryDef<LiveSessionsV1 | null> = {
  key: 'verse-fleet-live-sessions',
  fetch: async signal => narrowLiveSessions(await apiGet<unknown>(LIVE_SESSIONS_API, signal)),
};

/** "3 running · 1 quiet · 2 lanes · 1 on another computer". */
export function sessionsHeadline(list: LiveSessionsV1): string {
  const { sessions, quiet, lanes, otherComputers } = list.counts;
  return [`${sessions} running`, `${quiet} quiet`, `${lanes} ${lanes === 1 ? 'lane' : 'lanes'}`,
    ...(otherComputers ? [`${otherComputers} on another computer`] : [])].join(' · ');
}
