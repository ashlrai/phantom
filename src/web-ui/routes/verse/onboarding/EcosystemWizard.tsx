import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';
import { Button } from '../../../components/primitives/index.js';
import { Panel } from '../sections/SettingRow.js';
import styles from './onboarding.module.css';

interface Plan {
  schemaVersion: 1;
  planId: string;
  capabilities: { id: string; label: string; state: string; names: string[]; selected: boolean; next: string | null }[];
}
interface Receipt {
  phase: 'complete' | 'incomplete';
  results: { id: string; status: string; detail: string; next: string | null }[];
}

export function EcosystemWizard() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<'detecting' | 'preview' | 'granting' | 'result' | 'error'>('detecting');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiGet<Plan>('/api/onboard/ecosystem', controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setPlan(value);
      setSelected(new Set(value.capabilities.filter(row => row.selected).map(row => row.id)));
      setPhase('preview');
    }).catch(() => { if (!controller.signal.aborted) setPhase('error'); });
    return () => controller.abort();
  }, [revision]);
  async function grant() {
    const token = getMutationToken();
    if (!token || !plan) { setPhase('error'); return; }
    setPhase('granting');
    try {
      const value = await apiPost<Receipt>('/api/onboard/ecosystem/grant', { planId: plan.planId, selected: [...selected] }, token);
      setReceipt(value); setPhase('result');
    } catch { setPhase('error'); }
  }
  return <Panel title="Connect your ecosystem">
    <p>Use what is already on this computer. Choose capabilities, then grant the bundle once. Credentials stay in Phantom Secrets.</p>
    {phase === 'detecting' && <p role="status">Detecting existing tools...</p>}
    {(phase === 'preview' || phase === 'granting') && plan && <>
      <fieldset disabled={phase === 'granting'}>
        <legend>Capabilities</legend>
        {plan.capabilities.map(row => <div className={styles.guide} key={row.id}>
          <label><input type="checkbox" checked={selected.has(row.id)} onChange={() => setSelected(previous => {
            const next = new Set(previous);
            if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
            return next;
          })} /> {row.label}: {row.state}</label>
          {row.names.length > 0 && <p>{row.names.join(', ')}</p>}
          {row.next && <p>{row.next}</p>}
        </div>)}
      </fieldset>
      <Button onClick={() => void grant()} disabled={phase === 'granting' || selected.size === 0}>
        {phase === 'granting' ? 'Connecting...' : `Grant ${selected.size} capabilities`}
      </Button>
    </>}
    {phase === 'result' && receipt && <div role="status">
      <p>{receipt.phase === 'complete' ? 'Your selected integrations are configured.' : 'Some capabilities need a next step.'}</p>
      <ul>{receipt.results.map(row => <li key={row.id}><strong>{row.id}: {row.status}</strong>. {row.detail}{row.next && <p>{row.next}</p>}</li>)}</ul>
    </div>}
    {phase === 'error' && <p role="alert">Onboarding could not complete. Detect again to review current capabilities, or run phm onboard --ecosystem in a terminal.</p>}
    {(phase === 'result' || phase === 'error') && <Button variant="subtle" onClick={() => { setPhase('detecting'); setReceipt(null); setRevision(value => value + 1); }}>Detect again</Button>}
  </Panel>;
}
