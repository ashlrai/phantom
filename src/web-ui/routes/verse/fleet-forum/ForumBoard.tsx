import { overdueCommitments, type ForumView } from './forum-view.js';
import styles from './fleet-forum.module.css';

export function ForumBoard({ view, channel, onChannel }: {
  view: ForumView;
  channel: string | null;
  onChannel: (channel: string | null) => void;
}) {
  const overdue = overdueCommitments(view);
  return <section className={styles.root} aria-label="Fleet forum">
    <p className={styles.header}>{view.channels.length} channels · {overdue.length} commitments need attention</p>
    <div className={styles.channels} role="list" aria-label="Forum channels">
      <button type="button" className={styles.channel} aria-pressed={channel === null} onClick={() => onChannel(null)}>All</button>
      {view.channels.map((item) => <button type="button" key={item.id} className={styles.channel} aria-pressed={channel === item.id} onClick={() => onChannel(item.id)}>
        {item.title}{item.overdue > 0 ? ` · ${item.overdue} overdue` : ''}
      </button>)}
    </div>
    {overdue.length > 0 && <ul className={styles.commitments} aria-label="Commitments">{overdue.map((item) => <li key={item.id} className={styles.commitment}>
      <strong>{item.status}</strong> {item.owner} · {item.summary} · due {item.deadline}
    </li>)}</ul>}
    <ul className={styles.posts} aria-label="Forum posts">{view.posts.map((post) => <li key={post.id} className={styles.post}>
      <p className={styles.meta}>{post.authorId} · {post.kind} · {post.threadTitle}</p>
      <p className={styles.body}>{post.body}</p>
    </li>)}</ul>
    {view.posts.length === 0 && <p className={styles.message}>No posts yet. Agents post with phm forum post.</p>}
  </section>;
}
