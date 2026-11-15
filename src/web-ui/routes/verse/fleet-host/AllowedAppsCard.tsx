import { useRef, useState } from 'react';
import type { AppsActionReport, AppsListReport, AppAction } from '../../../../core/apps-control.js';
import { Button } from '../../../components/primitives/index.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import styles from './fleet-host.module.css';

const PATH = '/api/verse/apps/control';
const query = { key: 'allowed-apps', fetch: (signal?: AbortSignal) => apiGet<AppsListReport>(PATH, signal) };

/** The console uses the same per-app policy and results as phm apps. */
export function AllowedAppsCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(query, { enabled: active, freshMs: 60_000 });
  const refetch = useRefetch(query);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  const posting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const act = async (app: string, action: AppAction, request: boolean) => {
    if (posting.current || !active || read.status === 'error') return;
    const token = getMutationToken();
    if (!token) { setMessage('Unlock controls to manage apps.'); return; }
    posting.current = true; setBusy(true);
    try {
      const result = await apiPost<AppsActionReport>(PATH, { app, action, ...(request ? { request: true } : {}) }, token);
      if (result.action !== action || result.app !== app || !['done', 'needs-you'].includes(result.outcome)) throw new Error('invalid app response');
      touchMutationHold(); setMessage(`${app}: ${result.detail}`);
    } catch { setMessage('App action failed or was refused. Refresh app state before retrying.'); }
    finally { posting.current = false; setBusy(false); refetch(); }
  };
  return <section className={styles.section} aria-label="Allowed apps">
    <h3 className={styles.title}>Allowed apps</h3>
    {read.status === 'error' ? <p role="status">Allowed apps are unavailable. Controls are disabled.</p> : null}
    {!read.data ? <p className={styles.muted}>Reading allowed apps...</p> : <>
      {!read.data.connected ? <p className={styles.muted}>Desktop connection unavailable. App state is unknown; requests can still go to Needs you.</p> : null}
      {read.data.apps.length === 0 ? <p className={styles.muted}>No apps allowed. Configure apps-allow.json to enable app control.</p> : null}
      <ul>{read.data.apps.map(app => <li className={styles.line} key={app.name}>
        <span>{app.name}: {app.running === null ? 'unknown' : app.running ? 'running' : 'not running'}{app.frontmost ? ', frontmost' : ''}</span>
        <div className={styles.actions}>{app.actions.map(action => <Button key={action} size="sm"
          aria-label={`${app.mode === 'request' && action !== 'status' ? 'Request ' : ''}${action} ${app.name}`}
          disabled={busy || !active || read.status === 'error'} onClick={() => { void act(app.name, action, app.mode === 'request' && action !== 'status'); }}>
          {app.mode === 'request' && action !== 'status' ? 'Request ' : ''}{action}
        </Button>)}</div>
      </li>)}</ul>
    </>}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
