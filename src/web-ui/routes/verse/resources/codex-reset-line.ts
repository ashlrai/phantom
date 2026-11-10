/**
 * Two facts a Codex seat card may state about its weekly allowance. Both come
 * only from what the row already carries; anything absent or unparseable is
 * null, never a guess. Redeeming a free reset is root-coordinated, so there is
 * no action here, only words.
 */
import type { CapacityRow } from '../usage/capacity-strip-model.js';

/** The slice of a seat row these lines read. */
export type CodexResetRow = Pick<CapacityRow, 'engine' | 'windows' | 'resetAt'> & {
  /** A confirmed count from a reading; absent when no reading reported one. */
  freeResetsAvailable?: number | null;
};

function parseable(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The weekly window's reset, else the seat's own recorded reset. */
function resetInstant(row: CodexResetRow): number | null {
  const weekly = row.windows.find((w) => /weekly/i.test(w.label));
  return parseable(weekly?.resetsAt) ?? parseable(row.resetAt);
}

export function codexResetLine(row: CodexResetRow, now: number): string | null {
  if (row.engine !== 'codex') return null;
  const at = resetInstant(row);
  if (at === null) return null;
  const when = new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return at <= now ? `Reset due (was ${when}) · waiting for a fresh reading` : `Resets ${when} (in ${span(at - now)})`;
}

export function codexFreeResetsLine(row: CodexResetRow): string | null {
  if (row.engine !== 'codex') return null;
  const n = row.freeResetsAvailable;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? `Free resets: ${n} available` : null;
}
