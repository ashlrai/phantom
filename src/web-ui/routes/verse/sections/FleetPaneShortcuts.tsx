import { useEffect } from 'react';
import { usePanes } from '../panes/pane-registry.js';
import { formatChord, type KeyPlatform } from '../shell/command-keys.js';
import styles from '../shell/ShortcutsOverlay.module.css';

export function FleetPaneShortcuts({ platform }: { platform: KeyPlatform }) {
  const panes = usePanes();
  // Settings can be opened before the chat has loaded the pane registrations.
  useEffect(() => { void import('../panes/index.js'); }, []);
  const keyedPanes = panes.filter((pane) => pane.shortcut !== null);
  return (
    <section className={styles.section} aria-label="Fleet panes" style={{ marginTop: 'var(--space-6)' }}>
      <h3 className={styles.sectionTitle}>Fleet panes</h3>
      <dl className={styles.list}>
        {keyedPanes.map((pane) => (
          <div key={pane.id} className={styles.row}>
            <dt className={styles.action}>{pane.title}</dt>
            <dd className={styles.keys}><kbd className={styles.key}>{formatChord(pane.shortcut!, platform)}</kbd></dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
