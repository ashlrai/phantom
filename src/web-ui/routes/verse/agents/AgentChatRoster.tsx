import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { AGENTS_POLL_MS, agentsBoardQuery } from './agents-queries.js';
import styles from '../Sidebar.module.css';

/** Open the bound session: Workspace keeps the native Composer and Transcript. */
export function AgentChatRoster({ selectedId, onSelect, query }: {
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  query: string;
}) {
  const read = useQuery(agentsBoardQuery);
  const refetch = useRefetch(agentsBoardQuery);
  usePollWhileVisible(refetch, AGENTS_POLL_MS);
  const cards = read.data?.cards.filter(card => card.agentId && card.sessionId && !card.archived &&
    card.title.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  return <section className={styles.group} aria-label="Agent chats">
    <h2 className={styles.groupTitle}>Agent chats</h2>
    {read.status === 'error' ? <p role="status">Agent chats unavailable. <button type="button" onClick={refetch}>Retry</button></p>
      : !read.data ? <p role="status">Loading agent chats…</p>
      : cards.length === 0 ? <p>No matching agent chats.</p> : null}
    <ul className={styles.list}>
      {cards.map(card => <li key={card.id}>
        {/* Deliberate allowlist: never spread a record into DOM props or show
            prompts, scripts, environment, capability or raw error payloads. */}
        <button type="button" className={styles.session} aria-current={card.sessionId === selectedId ? 'page' : undefined}
          data-focus-key={`verse-session:${card.sessionId}`}
          onClick={() => onSelect(card.sessionId!)}>
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.sessionBody}><span className={styles.sessionText}>{card.title || 'Untitled agent'}</span></span>
        </button>
      </li>)}
    </ul>
  </section>;
}
