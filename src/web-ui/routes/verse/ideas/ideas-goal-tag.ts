import type { GoalSummary } from '../../../data/queries.js';

interface IdeaReference { title?: string; goalId?: string | null; goal_id?: string | null; goal?: { id: string } | null }
type Goal = GoalSummary & { slug?: string };

/** Resolve only whole identifiers or slugs; an explicit unknown id stays unlinked. */
export function tagIdeas<T extends IdeaReference>(ideas: readonly T[], goals: readonly Goal[]): Array<{ idea: T; goal: Goal | null }> {
  const tagged = ideas.map(idea => {
    const id = idea.goalId ?? idea.goal_id ?? idea.goal?.id;
    const tokens: readonly string[] = (idea.title ?? '').toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
    const goal = id != null
      ? goals.find(g => g.id === id)
      : goals.find(g => {
        const slug = g.slug ?? g.objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return tokens.includes(g.id.toLowerCase()) || (slug !== '' && tokens.includes(slug.toLowerCase()));
      });
    return { idea, goal: goal ?? null };
  });
  return [...tagged.filter(row => row.goal !== null), ...tagged.filter(row => row.goal === null)];
}
