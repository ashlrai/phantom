import type { LeaderJournalV1 } from '../leader-journal/leader-journal-model.js';

/** Use the newest pass only: an older CEO line must not look like today's plan. */
export function leaderCeoSummary(journal: LeaderJournalV1 | null | undefined): { lines: string[]; bottleneck: string | null } {
  if (journal?.sources.planLog !== 'healthy') return { lines: [], bottleneck: null };
  const latest = journal.passes[0];
  const sections = latest?.sections ?? [];
  return {
    lines: sections.filter(section => /\bCEO\b/i.test(section.title)).flatMap(section => section.bullets).slice(0, 3),
    bottleneck: sections.find(section => /bottleneck/i.test(section.title))?.bullets[0] ?? null,
  };
}
