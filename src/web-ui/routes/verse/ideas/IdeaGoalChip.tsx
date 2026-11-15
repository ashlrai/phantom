import type { GoalSummary } from '../../../data/queries.js';
import { openDockPane } from '../dock/dock-store.js';
import { scrollToAnchor } from '../command/nav.js';
import styles from './ideas.module.css';

export function IdeaGoalChip({ goal }: { goal: GoalSummary | null }) {
  if (!goal) return <span className={styles.meta}>no goal</span>;
  return <button type="button" className={styles.toggle} aria-label={`for: ${goal.objective.slice(0, 60)}`} onClick={() => {
    openDockPane('goals');
    requestAnimationFrame(() => scrollToAnchor(`goal-${goal.id}`));
  }}>→ {goal.objective}</button>;
}
