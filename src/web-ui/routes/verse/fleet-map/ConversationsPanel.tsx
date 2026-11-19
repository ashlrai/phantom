/**
 * The Conversations panel beside the Map: one row per agent thread, who is in it, its latest subject, its state in
 * plain words and how long ago it last moved. The thread that has waited longest for a reply is pinned on top (the
 * read already sorts that way). Select a row, or a line on the map, to read the thread. `phm agents conversations --json`
 * prints the same list. Subjects pass the shared secret scrub (conversations-model.ts).
 */
import { plainAge, type Conversation } from './conversations-model.js';
import { relativeAt } from '../fleet/bus-feed-model.js';
import styles from './fleet-map.module.css';

interface Props {
  /** Null when the bus could not be read: shown as unknown, never as no conversations. */
  conversations: Conversation[] | null | undefined;
  now: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export const participantsText = (c: Conversation) => c.participants.map(p => p.known ? p.name : `${p.label} (${p.name})`).join(', ');

export function ConversationsPanel({ conversations, now, selectedId, onSelect }: Props) {
  return <section className={styles.conversations} aria-label="Conversations">
    <h3 className={styles.panelTitle}>Conversations</h3>
    {conversations === undefined ? <p className={styles.notice}>Reading conversations…</p>
      : conversations === null ? <p className={styles.notice} role="status">Conversations unknown right now.</p>
      : conversations.length === 0 ? <p className={styles.notice}>No agent conversations yet.</p>
      : <ul className={styles.threads}>{conversations.map((c, index) => {
        const open = c.id === selectedId, pinned = index === 0 && c.state === 'waiting';
        return <li key={c.id} data-state={c.state} data-pinned={pinned ? 'true' : undefined}>
          <button type="button" aria-expanded={open} onClick={() => onSelect(open ? null : c.id)}>
            <strong>{participantsText(c)}</strong>
            <span className={styles.subject}>{c.subject}</span>
            <small>{c.waiting ? `${pinned ? 'Longest wait: ' : ''}waiting for reply from ${c.waiting.on} for ${plainAge(c.waiting.ms)}` : c.stateText}
              {' · '}{c.messageCount} message{c.messageCount === 1 ? '' : 's'} · {relativeAt(c.lastAt, now)}</small>
          </button>
          {open && <ol className={styles.thread} aria-label="Thread">{c.messages.map(m =>
            <li key={m.id}>{relativeAt(m.at, now)} · {m.from} → {m.to} · {m.kind}: {m.subject}</li>)}</ol>}
        </li>;
      })}</ul>}
    <p className={styles.notice}>For agents: <code>phm agents conversations --json</code></p>
  </section>;
}
