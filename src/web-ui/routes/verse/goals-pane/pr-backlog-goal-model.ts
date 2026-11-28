/**
 * routes/verse/goals-pane/pr-backlog-goal-model.ts: the "zero unresolved PRs"
 * order as one goal row, derived from the Merges backlog strip rows. Unknown
 * is never shown as 0.
 */
import type { RepoBacklogRow } from '../fleet-merges/repo-backlog-model.js';

export const PR_BACKLOG_GOAL_LABEL = 'Unresolved PRs across enrolled repos → 0';

export type PrBacklogGoalTone = 'met' | 'open' | 'unknown';

export interface PrBacklogGoal {
  label: string;
  value: string;
  tone: PrBacklogGoalTone;
  /** Absent on the first reading of the session. */
  trend?: string;
}

/** Exact trend denominator: every enrolled repo must have a complete read. */
export function prBacklogTotal(rows: readonly RepoBacklogRow[] | undefined): number | null {
  if (!rows?.length || rows.some(row => row.state !== 'ok' || !row.complete || row.open === null)) return null;
  return rows.reduce((sum, row) => sum + (row.open ?? 0), 0);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function prBacklogGoal(rows: readonly RepoBacklogRow[] | undefined, previousTotal?: number | null): PrBacklogGoal {
  const read = (rows ?? []).filter(row => row.state === 'ok' && row.open !== null);
  if (!read.length) return { label: PR_BACKLOG_GOAL_LABEL, value: 'unknown', tone: 'unknown' };
  const total = read.reduce((sum, row) => sum + (row.open ?? 0), 0);
  const partial = read.some(row => !row.complete);
  const dirty = read.reduce((sum, row) => sum + (row.dirty ?? 0), 0);
  const unread = rows!.length - read.length;
  const value = `${total} ${partial ? 'sampled · total unknown' : 'open'} · ${dirty} DIRTY${unread > 0 ? ` · ${plural(unread, 'repo', 'repos')} unread` : ''}`;
  // A partial read cannot prove the goal is met.
  const tone: PrBacklogGoalTone = total === 0 && partial ? 'unknown' : total === 0 && unread === 0 ? 'met' : 'open';
  if (partial || unread > 0 || typeof previousTotal !== 'number') return { label: PR_BACKLOG_GOAL_LABEL, value, tone };
  const diff = total - previousTotal;
  const trend = diff === 0 ? 'unchanged since you opened Phantom' : `${diff < 0 ? 'down' : 'up'} ${Math.abs(diff)} since you opened Phantom`;
  return { label: PR_BACKLOG_GOAL_LABEL, value, tone, trend };
}
