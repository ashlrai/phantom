import { ApiError } from '../../../data/client.js';
import { CardNote } from '../command/Surface.js';
import { handoffGroups, type HandoffsResponse } from './library-handoffs-model.js';
import styles from './library.module.css';

export function HandoffsSection({ data, error }: { data?: HandoffsResponse; error?: unknown }) {
  const groups = data ? handoffGroups(data.handoffs, Date.now()) : [];
  return (
    <section className={styles.section} aria-label="Agent handoffs">
      <h2>Agent handoffs</h2>
      {error && !data ? (
        error instanceof ApiError && error.status === 404
          ? <CardNote>This server does not read handoffs yet.</CardNote>
          : <CardNote tone="danger">Handoffs could not be read.</CardNote>
      ) : !data ? (
        <CardNote>Reading handoffs…</CardNote>
      ) : data.state === 'absent' ? (
        <CardNote>No handoff folder yet.</CardNote>
      ) : data.state === 'unavailable' ? (
        <CardNote tone="danger">Handoffs could not be read.</CardNote>
      ) : groups.length === 0 ? (
        <CardNote>No handoffs.</CardNote>
      ) : groups.map((group) => (
        <div key={group.folder}>
          <h3>{group.folder}</h3>
          <p className={styles.meta}>{group.rows.length} {group.rows.length === 1 ? 'file' : 'files'}</p>
          <ul className={styles.bus} aria-label={`${group.folder} handoffs`}>
            {group.rows.map((row) => <li className={styles.busRow} key={row.key}>
              <strong>{row.label}</strong>
              <span className={styles.meta}>{row.age} · {row.size}</span>
              <span className={styles.snippet}>{row.preview}</span>
            </li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}
