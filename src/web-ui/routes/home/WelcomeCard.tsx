/** The console face of `ashlr welcome`: five steps, each linking to where it is done. */
import { Link } from 'react-router-dom';
import { welcomeQuery } from '../../data/queries.js';
import { useQuery, useMutationHold } from '../../data/hooks.js';
import { markWelcome } from '../../data/mutations.js';
import styles from './HomeView.module.css';

export function WelcomeCard() {
  const q = useQuery(welcomeQuery);
  const hold = useMutationHold();
  const w = q.data;
  if (!w || w.complete) return null;
  const done = w.steps.filter((s) => s.state === 'done').length;
  return (
    <section className={styles.card} aria-label="Welcome">
      <h2 className={styles.h2}>Welcome — {done}/{w.steps.length} set up</h2>
      <ol className={styles.list}>
        {w.steps.map((s) => (
          <li key={s.id}>
            <strong>{s.state === 'done' ? '✓ ' : s.state === 'skipped' ? '– ' : ''}{s.title}</strong> <span className={styles.muted}>{s.why}</span>
            {s.state === 'todo' ? (
              <div><Link to={s.consoleHref}>Do it here</Link> · <code className={styles.cmd}>{s.command}</code>
                {hold.hasHold ? <> · <button type="button" onClick={() => void markWelcome(s.id, 'skipped')}>Skip</button></> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
