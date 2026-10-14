import { useEffect, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { DEVIN_READER_EVENT, nativeDevinReader, readDevinReaderEvent, type DevinReaderEvent } from './native-devin-reader.js';
import styles from '../resources/ResourcesDrawer.module.css';

const STATUS: Record<string, string> = {
  opening: 'Opening the separate Devin account window.',
  open: 'Sign in and open Devin General or Usage & limits, then refresh usage.',
  closed: 'Devin account window closed. No dashboard observation is active.',
  'not-open': 'Open the Devin account window first.',
  'open-general-or-usage': 'Navigate to General or Usage & limits in the Devin account window.',
  'organization-unavailable': 'Connect a verified Devin API organization before reading its dashboard.',
  'media-guard-unavailable': 'The account window was closed because the native media guard could not be confirmed.',
  'page-changed': 'The page changed during refresh. Open General and try again.',
  'read-failed': 'The dashboard labels could not be read. Open General and try again.',
  'open-general-first': 'Sign in and open General or Usage & limits for the connected organization, then refresh.',
  'refresh-in-progress': 'A dashboard refresh is already running.',
  'refreshing-general': 'Reading the organization ID before the usage page.',
  'refreshing-usage': 'Reading the Usage & limits page.',
  'confirming-general': 'Confirming the same organization after the usage page.',
  'refresh-cancelled': 'The refresh was cancelled because the page changed or closed.',
  'auto-on': 'Automatic refresh is on while this account window stays open.',
  'auto-off': 'Automatic refresh is off.',
  'page-loading': 'The dashboard page is loading.',
  'general-verified-read-usage': 'Organization ID matches. Reading usage.',
  'usage-held-confirm-general': 'Usage was read. Confirming the organization.',
  'verify-general-first': 'Open General and refresh again.',
  'restart-verification': 'The reading expired or changed. Start again on General.',
  'organization-mismatch': 'The dashboard organization differs from the connected Devin organization.',
  'external-sign-in-unavailable': 'This sign-in leaves Devin. Embedded Google or other external sign-in is unavailable here; use Devin in your browser.',
  'usage-unavailable': 'The usage labels or values were not recognized. No balance is reported.',
  unavailable: 'The dashboard observation is unavailable. Use the Devin website.',
};

const INVALIDATES_OBSERVATION = new Set([
  'closed', 'not-open', 'organization-unavailable', 'organization-mismatch',
  'media-guard-unavailable', 'page-unavailable', 'page-changed', 'read-failed', 'refresh-cancelled',
  'open-general-first', 'open-general-or-usage',
  'verify-general-first', 'restart-verification', 'external-sign-in-unavailable',
  'usage-unavailable', 'unavailable',
]);

type Snapshot = Extract<DevinReaderEvent, { kind: 'snapshot' }>;

export function DevinDashboardReader({ orgId }: { orgId: string | null }) {
  const bridge = nativeDevinReader();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setSnapshot(null); setStatus(null); setAutoEnabled(false); }, [orgId]);
  useEffect(() => {
    const onNative = (raw: Event) => {
      const next = readDevinReaderEvent(raw);
      if (!next) return;
      if (next.kind === 'snapshot') {
        if (next.orgId !== orgId) return;
        setSnapshot(next);
        setStatus(null);
      } else {
        setStatus(next.state);
        if (INVALIDATES_OBSERVATION.has(next.state)) setSnapshot(null);
        if (next.state === 'closed' || next.state === 'auto-off' || next.state === 'not-open') setAutoEnabled(false);
      }
      setNow(Date.now());
    };
    window.addEventListener(DEVIN_READER_EVENT, onNative);
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    const onResume = () => {
      const resumedAt = Date.now();
      setNow(resumedAt);
      setSnapshot((current) => current && current.expiresAtMs <= resumedAt ? null : current);
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener(DEVIN_READER_EVENT, onNative);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
      window.clearInterval(timer);
    };
  }, [orgId]);
  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setTimeout(() => setSnapshot((current) => current === snapshot ? null : current),
      Math.max(0, snapshot.expiresAtMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [snapshot]);
  if (!bridge || !orgId) return null;
  const current = snapshot?.orgId === orgId && snapshot.expiresAtMs > now ? snapshot : null;
  return <section aria-label="Devin dashboard observation">
    <p className={styles.creditsHead}><span>Devin dashboard observation</span><span className={styles.pill} data-tone="neutral">display only</span></p>
    <p className={styles.fine}>See the connected organization's displayed usage in a separate Devin window. Phantom does not share its cookies with the agent browser or use this observation to authorize spending. Sign in, open General or Usage &amp; limits, then refresh. Readings expire after two minutes.</p>
    <div>
      <Button size="sm" variant="ghost" onClick={() => { bridge.send({ op: 'open', orgId }); }}>Open Devin account window</Button>{' '}
      <Button size="sm" variant="ghost" onClick={() => bridge.send({ op: 'capture' })}>Refresh usage</Button>{' '}
      <Button size="sm" variant="ghost" onClick={() => { if (bridge.send({ op: 'auto', enabled: !autoEnabled })) setAutoEnabled(!autoEnabled); }}>{autoEnabled ? 'Auto refresh on' : 'Auto refresh off'}</Button>{' '}
      <Button size="sm" variant="ghost" onClick={() => { bridge.send({ op: 'close' }); setAutoEnabled(false); setSnapshot(null); setStatus('closed'); }}>Close</Button>
    </div>
    {current ? <div role="status">
      <p className={styles.fine}>Organization dashboard observation · {new Date(current.observedAtMs).toLocaleTimeString()} · account identity unverified</p>
      <p className={styles.fine}>Max · ${current.usage.monthlyPriceUsd}/month · weekly {current.usage.weeklyUsedPercent}% used{current.usage.resetProse ? ` · ${current.usage.resetProse}` : ''}</p>
      <p className={styles.fine}>On-demand balance ${current.usage.onDemandBalanceUsd.toFixed(2)} · auto-reload {current.usage.autoReload === null ? 'not observed' : current.usage.autoReload ? 'on' : 'off'}</p>
      {status ? <p className={styles.fine}>{STATUS[status] ?? 'Checking the dashboard.'}</p> : null}
    </div> : <p className={styles.fine} role="status">{status ? STATUS[status] ?? 'No current dashboard observation is available.' : 'No current dashboard observation is available.'}</p>}
  </section>;
}
