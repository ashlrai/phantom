import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { HostSummary } from '../../../core/web/host-summary.js';
import { Button } from '../../components/primitives/Button.js';
import { Dialog } from '../../components/primitives/Dialog.js';
import { apiGet } from '../../data/client.js';
import { usePollWhileVisible } from './shell/section-visibility.js';
import { setVerseSection, setVerseSidebarCollapsed } from './verse-ui-store.js';
import styles from './SidebarResources.module.css';

/** Navigation only. Opening a group never starts an agent or a routine. */
export const SidebarResources = memo(function SidebarResources() {
  const [machineOpen, setMachineOpen] = useState(false);
  const titleId = useId();

  function navigate(section: 'agents' | 'automations') {
    setVerseSection(section);
    // Match the shell's other navigation entries on the floating phone list.
    if (window.matchMedia?.('(max-width: 760px)')?.matches) setVerseSidebarCollapsed(true);
  }

  return (
    <div className={styles.resources}>
      <section aria-label="Agents">
        <h2 className={styles.heading}>Agents</h2>
        <button type="button" className={styles.entry} onClick={() => navigate('agents')}>View agents</button>
      </section>
      <section aria-label="Routines">
        <h2 className={styles.heading}>Routines</h2>
        <button type="button" className={styles.entry} onClick={() => navigate('automations')}>View routines</button>
      </section>
      <section aria-label="Machine">
        <h2 className={styles.heading}>Machine</h2>
        <button type="button" className={styles.entry} aria-haspopup="dialog" onClick={() => setMachineOpen(true)}>This machine</button>
      </section>
      <Dialog open={machineOpen} onClose={() => setMachineOpen(false)} titleId={titleId} title="This machine">
        {/* Mount on demand: no host read on chat startup, and every reopen
            takes a fresh observation rather than trusting a cached Stop. */}
        {machineOpen ? <MachineSummary onClose={() => setMachineOpen(false)} /> : null}
      </Dialog>
    </div>
  );
});

function MachineSummary({ onClose }: { onClose: () => void }) {
  // This observation belongs to one modal opening, not the shared warm-data
  // cache: an old clear Stop must never flash while a fresh read is pending.
  const [reading, setReading] = useState<{ status: 'loading' | 'success' | 'error'; data: HostSummary | null }>({ status: 'loading', data: null });
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setReading({ status: 'loading', data: null });
    void apiGet<HostSummary>('/api/host', request.signal).then((data) => {
      if (!request.signal.aborted && pending.current === request) setReading({ status: 'success', data });
    }).catch(() => {
      if (!request.signal.aborted && pending.current === request) setReading({ status: 'error', data: null });
    }).finally(() => {
      if (pending.current === request) pending.current = null;
    });
  }, []);
  useEffect(() => {
    refresh();
    return () => pending.current?.abort();
  }, [refresh]);
  // Leave a slow read in flight; an explicit Refresh always starts a new one.
  usePollWhileVisible(() => { if (!pending.current) refresh(); }, 10_000);
  const data = reading.data;
  const busy = reading.status === 'loading';
  const stop = data?.killSwitch.state;

  return (
    <div className={styles.summary}>
      {reading.status === 'error' ? <p role="alert">Machine status unavailable. Refresh to try again.</p>
        : busy ? <p role="status">Reading machine status…</p> : null}
      <dl className={styles.facts}>
        <dt>Console</dt><dd>{data?.console.url ?? 'Unknown'}</dd>
        <dt>Console bind</dt>
        <dd>{data?.console.bindHost ?? 'Unknown'}{data?.console.loopback === true ? ' (loopback)' : data?.console.loopback === false ? ' (non-loopback)' : ''}</dd>
        <dt>Local inference bind (configured)</dt><dd>{data?.localInference.bindHost ?? 'Unknown'}</dd>
        <dt>Stop marker (~/.ashlr/KILL)</dt>
        <dd>{stop === 'active' ? 'Present — Stop engaged' : stop === 'inactive' ? 'Absent — Stop not engaged' : 'Unknown'}</dd>
      </dl>
      <p className={styles.note}>The configured inference bind does not indicate a running model. An absent Stop marker does not authorize work.</p>
      {data ? <p className={styles.note}>Observed <time dateTime={data.observedAt}>{new Date(data.observedAt).toLocaleTimeString()}</time></p> : null}
      <div className={styles.actions}>
        <Button variant="subtle" disabled={busy} onClick={refresh}>Refresh</Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
