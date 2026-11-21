import type { AgentCard } from '../../../../core/verse/agents/types.js';
import styles from './Agents.module.css';

const MAX = 8;

export function agentInitials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

/** One avatar per agent, coloured by its engine: the roster a group chat will reuse. */
export function AgentRoster({ cards }: { cards: readonly AgentCard[] }) {
  const byAgent = new Map<string, AgentCard>();
  for (const card of cards) if (card.agentId && !card.archived && !byAgent.has(card.agentId)) byAgent.set(card.agentId, card);
  const agents = [...byAgent.values()];
  if (agents.length === 0) return null;
  return (
    <ul className={styles.roster} aria-label="Agent roster">
      {agents.slice(0, MAX).map(card => (
        <li key={card.agentId}>
          <span className={styles.avatar} role="img" data-engine={card.engine ?? undefined} data-working={card.column === 'working' || undefined}
            title={card.title} aria-label={`${card.title}${card.column === 'working' ? ', working' : ''}`}>
            {agentInitials(card.title)}
          </span>
        </li>
      ))}
      {agents.length > MAX ? <li><span className={styles.avatar} role="img" aria-label={`${agents.length - MAX} more agents`}>+{agents.length - MAX}</span></li> : null}
    </ul>
  );
}
