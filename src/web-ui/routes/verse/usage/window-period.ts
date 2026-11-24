/**
 * routes/verse/usage/window-period.ts: when a usage window began, read from the `resetProvenance` the server
 * attaches to a window. The accounts read (usage-contract) and the seat roster (seat-subscription) carry the
 * same provenance, so both project it here and every surface agrees on which windows have a known start.
 *
 * `reported`: the provider gave the period's own start (Grok's billing period).
 * `weekly`: the server qualified the reset as a weekly deadline, so the window began seven days before it.
 * Any other kind, or a provenance that names a different reset than the window's, has no known start: null,
 * and nothing is drawn against time. Pure, no imports, so the chat surfaces can load it at first paint.
 */
export interface WindowPeriod { startsAt: string; basis: 'reported' | 'weekly' }

const WEEK_MS = 7 * 86_400_000;

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function projectPeriod(raw: unknown, resetsAt: string | null): WindowPeriod | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const end = resetsAt === null ? NaN : Date.parse(resetsAt);
  const at = text(r['at']);
  if (!Number.isFinite(end) || at === null || Date.parse(at) !== end) return null;
  if (r['kind'] === 'weekly-deadline') return { startsAt: new Date(end - WEEK_MS).toISOString(), basis: 'weekly' };
  if (r['kind'] !== 'fixed-period') return null;
  const startsAt = text(r['startsAt']);
  const start = startsAt === null ? NaN : Date.parse(startsAt);
  return Number.isFinite(start) && start < end ? { startsAt: new Date(start).toISOString(), basis: 'reported' } : null;
}
