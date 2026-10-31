import { useRef, useState } from 'react';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { changeConnector, connectorsQuery, type Connector } from './connectors-client.js';
import styles from '../../verse/sections/SettingsSection.module.css';

/** Rollout flag supplied by the host; absent flags keep the workspace surface off. */
export function ConnectorsSettings() {
  const flags = (window as unknown as { __ASHLR_FEATURE_FLAGS__?: { agentWorkspace?: boolean } }).__ASHLR_FEATURE_FLAGS__;
  return flags?.agentWorkspace === true ? <ConnectorsView /> : null;
}

/** Only names and state cross the display boundary. */
export function ConnectorsView() {
  const query = useQuery(connectorsQuery);
  const refresh = useRefetch(connectorsQuery);
  const { hasHold } = useMutationHold();
  const [selected, setSelected] = useState<{ connector: Connector; revision: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');

  async function confirm() {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await changeConnector(selected.connector, selected.revision);
      setMessage('Connector updated. Restart gateway clients to apply the change.');
      setSelected(null);
      refresh();
    } catch {
      setMessage('Connector change refused. Refresh and try again.');
      setSelected(null);
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <section className={styles.panel} aria-label="Connectors and MCP">
    <div className={styles.panelHead}>
      <h3 className={styles.panelTitle}>Connectors and MCP</h3>
      <button type="button" disabled={busy} onClick={() => { setSelected(null); setMessage(''); refresh(); }}>Refresh connectors</button>
    </div>
    <p>Manage Phantom’s gateway registry. Changes apply when gateway clients restart. Account-managed servers remain in Apps &amp; Accounts.</p>
    <p>Credentials and capabilities are never displayed. Manage credentials through Phantom Secrets.</p>
    {!hasHold && <p>Unlock actions in Connection before changing connectors.</p>}
    {query.status === 'error' ? <p role="alert">Connectors could not be loaded. Refresh to try again.</p> : !query.data ? <p role="status">Loading connectors…</p> : <div className={styles.panelBody}>
      {query.data.connectors.length === 0 && <p>No Phantom gateway connectors configured.</p>}
      {query.data.connectors.map((connector) => <div className={styles.row} key={connector.name}>
        <div><strong>{connector.name}</strong><p>{connector.enabled ? 'Enabled' : 'Disabled'}</p></div>
        <button type="button" disabled={!hasHold || busy || selected !== null} onClick={() => { setMessage(''); setSelected({ connector, revision: query.data!.revision }); }}>
          {connector.enabled ? 'Disable' : 'Enable'} {connector.name}
        </button>
      </div>)}
    </div>}
    {selected && <div role="group" aria-label="Confirm connector change">
      <p>{selected.connector.enabled ? 'Disable' : 'Enable'} {selected.connector.name}? Enabling makes this server’s tools available to gateway clients.</p>
      <button type="button" disabled={busy || !hasHold} onClick={() => { void confirm(); }}>{busy ? 'Updating…' : 'Confirm change'}</button>
      <button type="button" disabled={busy} onClick={() => setSelected(null)}>Cancel</button>
    </div>}
    <p role="status">{message}</p>
  </section>;
}
