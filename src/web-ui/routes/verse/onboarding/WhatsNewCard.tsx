import { useEffect } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { openFleetWorkspace } from '../dock/dock-store.js';
import { fleetPanesPresent } from '../dock/fleet-workspace-auto.js';
import { listPanes } from '../panes/index.js';
import { APP_VERSION } from '../sections/app-version.js';
import { setVerseSection } from '../verse-ui-store.js';
import { markReleaseSeen } from './onboarding-store.js';
import styles from './onboarding.module.css';

export function WhatsNewCard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') markReleaseSeen(APP_VERSION);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function openFleet() {
    const available = fleetPanesPresent(listPanes().map(p => p.id));
    if (available.length > 0) openFleetWorkspace(available);
    else setVerseSection('fleet');
    markReleaseSeen(APP_VERSION);
  }

  return (
    <section className={styles.card} aria-labelledby="whats-new-title">
      <header className={styles.head}>
        <h2 id="whats-new-title" className={styles.title}>What's new in Phantom {APP_VERSION}</h2>
      </header>
      <div className={styles.body}>
        <p className={styles.lead}>Fleet workspace: live jobs, lanes and merges from this Mac</p>
        <p className={styles.lead}>Leaders' inbox: your prompts land in MASON-INBOX.md</p>
        <p className={styles.lead}>Ops tray: queue, releases and lane targets</p>
      </div>
      <footer className={styles.foot}>
        <Button variant="primary" size="sm" onClick={openFleet}>Open fleet workspace</Button>
        <Button variant="ghost" size="sm" onClick={() => markReleaseSeen(APP_VERSION)}>Later</Button>
      </footer>
    </section>
  );
}
