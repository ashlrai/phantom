import { useId, useRef, useState } from 'react';
import styles from './leader-thread.module.css';

const views = [
  { key: 'routing', label: 'Routing', metric: 'Routed jobs in flight', pane: 'fleet-inbox', action: 'Open order inbox' },
  { key: 'lanes', label: 'Lanes', metric: 'Observed lanes', pane: 'fleet-lanes', action: 'Open lane health' },
  { key: 'delivery', label: 'Delivery', metric: 'Merges in the last hour', pane: 'fleet-merges', action: 'Open merge evidence' },
] as const;

type View = (typeof views)[number];
type Evidence = Record<View['key'], number | null>;

/** An on-demand, read-only view over the Leader's existing queries. The
 * catalog owns navigation; free-form messages cannot create controls. */
export function LeaderFleetContext({ evidence, onOpen }: {
  evidence: Evidence;
  onOpen: (pane: View['pane']) => void;
}) {
  const id = useId();
  const headingId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [view, select] = useState<View>(views[0]);
  const value = evidence[view.key];

  function close() {
    setExpanded(false);
    toggle.current?.focus();
  }

  return <div className={styles.fleetContext} onKeyDown={event => {
    if (expanded && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <button ref={toggle} type="button" className={styles.tool} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(current => !current)}>Fleet context</button>
    <section hidden={!expanded} id={id} aria-labelledby={headingId} className={styles.contextPanel}>
      <div className={styles.contextHeader}>
        <h3 id={headingId}>Fleet context</h3>
        <button type="button" className={styles.tool} onClick={close}>Close</button>
      </div>
      <div className={styles.contextChoices} role="group" aria-label="Evidence view">
        {views.map(item => <button type="button" key={item.key} className={styles.tool}
          aria-pressed={item.key === view.key} onClick={() => select(item)}>{item.label}</button>)}
      </div>
      <dl className={styles.contextReading}>
        <dt>{view.metric}</dt>
        <dd className={value === null ? styles.unknown : undefined}>{value === null ? 'Unknown' : value}</dd>
      </dl>
      <button type="button" className={styles.tool} onClick={() => onOpen(view.pane)}>{view.action}</button>
    </section>
  </div>;
}
