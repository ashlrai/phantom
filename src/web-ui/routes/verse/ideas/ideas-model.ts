/**
 * routes/verse/ideas/ideas-model.ts: pure shaping of the ranked backlog for
 * the Ideas pane. No React, no fetch; the pane feeds it `verseBacklogQuery`
 * items. Every string is untrusted and is only ever rendered as text.
 */
import type { VerseBacklogItem } from '../autonomy/control-queries.js';
import { repoDisplayName } from '../autonomy/format.js';

export interface IdeaRow {
  key: string;
  title: string;
  repo: string;
  /** Raw score, or null when the loop did not score the item. */
  score: number | null;
  scoreText: string;
  source: string;
  /** Set on goal-drift ideas: the goal they came from. */
  goal?: { id: string; name: string };
}

export interface RepoGroup {
  repo: string;
  rows: IdeaRow[];
  /** Rows beyond `perRepo` that are not in `rows`. */
  more: number;
}

export const UNASSIGNED = 'unassigned';
export const UNKNOWN_SOURCE = 'unknown';
export const NUDGE_MIN_ROWS = 10;
export const NUDGE_SHARE = 0.8;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** Drop untitled/unidentified items; best score first, unscored last, ties keep input order. */
export function rankIdeas(items: readonly VerseBacklogItem[]): IdeaRow[] {
  const rows: (IdeaRow & { order: number })[] = [];
  items.forEach((item, order) => {
    if (typeof item !== 'object' || item === null) return;
    const id = text(item.id);
    const title = text(item.title) ?? id;
    if (title === undefined) return;
    const repo = text(item.repo);
    const goalId = text((item as { goalId?: unknown }).goalId);
    const goalName = text((item as { goalName?: unknown }).goalName);
    const source = text(item.source) ?? UNKNOWN_SOURCE;
    const score = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null;
    rows.push({
      key: `${id ?? title}#${order}`,
      title,
      repo: repo ? repoDisplayName(repo) : UNASSIGNED,
      score,
      scoreText: score === null ? 'unscored' : `score ${score}`,
      source,
      ...(source === 'goal-drift' && goalId ? { goal: { id: goalId, name: goalName ?? goalId } } : {}),
      order,
    });
  });
  rows.sort((a, b) => {
    if (a.score === null || b.score === null) return a.score === b.score ? a.order - b.order : a.score === null ? 1 : -1;
    return b.score - a.score || a.order - b.order;
  });
  return rows.map(({ order: _order, ...row }) => row);
}

/** Repos ordered by their best row; `rows` must already be ranked. */
export function groupByRepo(rows: readonly IdeaRow[], perRepo = 5): RepoGroup[] {
  const byRepo = new Map<string, IdeaRow[]>();
  for (const row of rows) {
    const list = byRepo.get(row.repo);
    if (list) list.push(row); else byRepo.set(row.repo, [row]);
  }
  const limit = Math.max(1, perRepo);
  // Map order is first-seen order, which is best-row order for ranked input.
  return [...byRepo].map(([repo, list]) => ({ repo, rows: list.slice(0, limit), more: Math.max(0, list.length - limit) }));
}

export function ideasHeadline(rows: readonly IdeaRow[]): string {
  const top = rows[0];
  if (!top) return 'No candidates yet';
  const repos = new Set(rows.map(r => r.repo)).size;
  return `${rows.length} candidate${rows.length === 1 ? '' : 's'} across ${repos} repo${repos === 1 ? '' : 's'}. Top: ${top.title}`;
}

export interface SourceCounts {
  /** Most common first; ties by name. */
  counts: { source: string; count: number }[];
  /** Set when one source dominates a big enough list; computed from data only. */
  nudge: string | null;
}

export function sourceCounts(rows: readonly IdeaRow[]): SourceCounts {
  const tally = new Map<string, number>();
  for (const row of rows) tally.set(row.source, (tally.get(row.source) ?? 0) + 1);
  const counts = [...tally].map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const lead = counts[0];
  const nudge = lead && rows.length >= NUDGE_MIN_ROWS && lead.count / rows.length >= NUDGE_SHARE
    ? `Most ideas come from ${lead.source}; consider adding a goal to widen the search.`
    : null;
  return { counts, nudge };
}
