/**
 * components/states/States.tsx — the one empty state and the one error state
 * every page uses. An error always names what failed and the exact command or
 * place that fixes it; an empty state always names the next action.
 */
import type { ReactNode } from 'react';
import styles from './States.module.css';

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return <section className={styles.empty} aria-label={title}><h2 className={styles.title}>{title}</h2>{body ? <p>{body}</p> : null}{action ? <div>{action}</div> : null}</section>;
}

export function ErrorState({ what, error, fix }: { what: string; error?: unknown; fix: string }) {
  const detail = error instanceof Error ? error.message : error ? String(error) : null;
  return (
    <div role="alert" className={styles.error}>
      <p className={styles.title}>{what} could not load.</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      <p>Fix: <code>{fix}</code></p>
    </div>
  );
}
