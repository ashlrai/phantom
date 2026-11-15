/**
 * growth/CapabilityGapsPanel.tsx — what Phantom still cannot do itself, from
 * the static capability audit. "Draft job" only opens the New job sheet with
 * a seeded draft; nothing is queued until someone submits it. Held items
 * (hard limits) are one collapsed line and never get a button.
 */
import { useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { openDropJobSheet } from '../fleet-queue/drop-job-sheet-store.js';
import { capabilityGapsView, type GapRow } from './capability-gaps-model.js';
import styles from './capability-gaps.module.css';

const view = capabilityGapsView();

export function CapabilityGapsPanel() {
  const [note, setNote] = useState<string | null>(null);
  const draft = (row: GapRow) => {
    setNote(openDropJobSheet(row.draft) === 'kept' ? 'You have an unsent draft; this one was not applied.' : null);
  };
  return (
    <section className={styles.panel} aria-label="Capability gaps">
      <h3 className={styles.headline}>{view.headline}</h3>
      <ul className={styles.domains} aria-label="By domain">
        {view.domains.map(d => (
          <li key={d.domain}>{d.domain}: <b>{d.parity}</b> parity · <b>{d.partial}</b> partial · <b>{d.gap}</b> gap</li>
        ))}
      </ul>
      <ul className={styles.gaps} aria-label="Top gaps to close">
        {view.top.map(row => (
          <li key={row.id} className={styles.gap} data-surface={row.id}>
            <span className={styles.summary}>{row.summary}<br /><span className={styles.meta}>{row.domain} · {row.id}</span></span>
            <span className={styles.badge} title="Leverage">L{row.leverage}</span>
            <Button size="sm" onClick={() => draft(row)}>Draft job</Button>
          </li>
        ))}
      </ul>
      {note ? <p className={styles.held} role="status">{note}</p> : null}
      <details>
        <summary className={styles.held}>{view.heldLine}</summary>
      </details>
    </section>
  );
}
