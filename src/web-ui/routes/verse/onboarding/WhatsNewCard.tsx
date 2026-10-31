import { useEffect } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { fleetSourcesQuery } from '../sections/fleet-sources-query.js';
import { readFleetPresence, whatsNewCopy } from './fleet-presence.js';
import { Button } from '../../../components/primitives/index.js';
import { openFleetWorkspace } from '../dock/dock-store.js';
import { fleetPanesPresent } from '../dock/fleet-workspace-auto.js';
import { listPanes } from '../panes/index.js';
import { APP_VERSION } from '../sections/app-version.js';
import { setVerseSection } from '../verse-ui-store.js';
import { markReleaseSeen } from './onboarding-store.js';
import styles from './onboarding.module.css';

export function WhatsNewCard() {
  const { data } = useQuery(fleetSourcesQuery);
  const copy = whatsNewCopy(readFleetPresence(data));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') markReleaseSeen(APP_VERSION);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function openPrimary() {
    if (copy.primary.action !== 'fleet-workspace') {
      if (copy.primary.action === 'fleet-sources') setVerseSection('settings', 'fleet-sources');
      else setVerseSection('settings');
      markReleaseSeen(APP_VERSION);
      return;
    }
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
        {copy.bullets.map(bullet => <p key={bullet} className={styles.lead}>{bullet}</p>)}
      </div>
      <footer className={styles.foot}>
        <Button variant="primary" size="sm" onClick={openPrimary}>{copy.primary.label}</Button>
        <Button variant="ghost" size="sm" onClick={() => markReleaseSeen(APP_VERSION)}>Later</Button>
      </footer>
    </section>
  );
}
