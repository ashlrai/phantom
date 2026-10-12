import { useEffect, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { DEVIN_READER_EVENT, nativeDevinReader, readDevinReaderEvent, type DevinReaderEvent } from './native-devin-reader.js';
import styles from '../resources/ResourcesDrawer.module.css';

const STATUS: Record<string, string> = {
  opening: 'Opening the separate Devin account window.',
  open: 'Open Devin General, then record that page.',
  closed: 'Devin account window closed. No dashboard observation is active.',
  'not-open': 'Open the Devin account window first.',
  'open-general-or-usage': 'Navigate to General or Usage & limits in the Devin account window.',
  'organization-unavailable': 'Connect a verified Devin API organization before reading its dashboard.',
  'media-guard-unavailable': 'The account window was closed because the native media guard could not be confirmed.',
  'page-changed': 'The page changed during capture. Record General again.',
  'read-failed': 'The dashboard labels could not be read. Record the page again.',
  'page-loading': 'Page changed. Record General, Usage, then General again within two minutes.',
  'general-verified-read-usage': 'Organization ID matches. Open Usage & limits in the Devin window and record it.',
  'usage-held-confirm-general': 'Usage is held privately. Return to General and record it again to confirm the same organization.',
  'verify-general-first': 'Open General and record its organization ID first.',
  'restart-verification': 'The reading expired or changed. Start again on General.',
  'organization-mismatch': 'The dashboard organization differs from the connected Devin organization.',
  'external-sign-in-unavailable': 'This sign-in leaves Devin. Embedded Google or other external sign-in is unavailable here; use Devin in your browser.',
  'usage-unavailable': 'The usage labels or values were not recognized. No balance is reported.',
  unavailable: 'The dashboard observation is unavailable. Use the Devin website.',
};

export function DevinDashboardReader({ orgId }: { orgId: string | null }) {
  const bridge = nativeDevinReader();
  const [event, setEvent] = useState<DevinReaderEvent | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setEvent(null); }, [orgId]);
  useEffect(() => {
    const onNative = (raw: Event) => {
      const next = readDevinReaderEvent(raw);
      if (!next) return;
      setEvent(next);
      setNow(Date.now());
    };
    window.addEventListener(DEVIN_READER_EVENT, onNative);
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { window.removeEventListener(DEVIN_READER_EVENT, onNative); window.clearInterval(timer); };
  }, []);
  if (!bridge || !orgId) return null;
  const snapshot = event?.kind === 'snapshot' && event.orgId === orgId && event.expiresAtMs > now ? event : null;
  return <section aria-label="Devin dashboard observation">
    <p className={styles.creditsHead}><span>Devin dashboard observation</span><span className={styles.pill} data-tone="neutral">display only</span></p>
    <p className={styles.fine}>Observe the signed-in organization's displayed allowance without sharing cookies with Phantom's agent browser. The Devin window still allows normal account actions; Phantom only extracts these fields. This does not prove a human billing seat or authorize session spending.</p>
    <p className={styles.fine}>In the separate Devin window, record General, then Usage &amp; limits, then General again. Each reading expires after two minutes.</p>
    <div>
      <Button size="sm" variant="ghost" onClick={() => { setEvent(null); bridge.send({ op: 'open', orgId }); }}>Open Devin account window</Button>{' '}
      <Button size="sm" variant="ghost" onClick={() => bridge.send({ op: 'capture' })}>Record this page</Button>{' '}
      <Button size="sm" variant="ghost" onClick={() => { bridge.send({ op: 'close' }); setEvent(null); }}>Close</Button>
    </div>
    {snapshot ? <div role="status">
      <p className={styles.fine}>Organization dashboard observation · {new Date(snapshot.observedAtMs).toLocaleTimeString()} · account identity unverified</p>
      <p className={styles.fine}>Max · ${snapshot.usage.monthlyPriceUsd}/month · weekly {snapshot.usage.weeklyUsedPercent}% used{snapshot.usage.resetProse ? ` · ${snapshot.usage.resetProse}` : ''}</p>
      <p className={styles.fine}>On-demand balance ${snapshot.usage.onDemandBalanceUsd.toFixed(2)} · auto-reload {snapshot.usage.autoReload === null ? 'not observed' : snapshot.usage.autoReload ? 'on' : 'off'}</p>
    </div> : <p className={styles.fine} role="status">{event?.kind === 'status' ? STATUS[event.state] ?? 'No current dashboard observation is available.' : 'No current dashboard observation is available.'}</p>}
  </section>;
}
