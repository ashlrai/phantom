/** The one card shape every Home card uses: a title, the facts, and exactly one action. */
import type { ReactNode } from 'react';
import type { HomeField } from '../../../../core/fleet/home.js';
import styles from './home.module.css';

export function Value<T>({ field, children }: { field: HomeField<T>; children: (value: T) => ReactNode }) {
  return field.state === 'ok' ? <>{children(field.value)}</> : <span data-unknown>Unknown: {field.reason}</span>;
}
export function Card({ title, action, onOpen, children }: { title: string; action: string; onOpen: () => void; children: ReactNode }) {
  return <section className={styles.card} aria-label={title}><h3>{title}</h3>{children}<button type="button" className={styles.action} onClick={onOpen}>{action}</button></section>;
}
