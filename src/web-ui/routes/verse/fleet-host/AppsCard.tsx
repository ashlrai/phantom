import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_CONFIRM_MS, appActionFailureText, postAppAction } from './apps-action.js';
import { appRows, appActionsFor, appActionConfirmLabel, appActionOutcomeText, type AppAction } from './apps-card-model.js';
import { appsCardQuery } from './apps-card-query.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { appRecoveryRow } from './apps-recovery-row-model.js';
import styles from './fleet-host.module.css';

const recoveryQuery = { key: 'fleet-apps-recovery', async fetch(signal?: AbortSignal): Promise<unknown> {
  try { return await apiGet<unknown>('/api/verse/fleet/apps/recovery', signal); } catch { return null; }
} };

export function AppsCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(appsCardQuery, { enabled: active, freshMs: 60_000 });
  const recovery = useQuery(recoveryQuery, { enabled: active, freshMs: 60_000 });
  const refreshRecovery = useRefetch(recoveryQuery);
  usePollWhileVisible(refreshRecovery, 60_000, { enabled: visible, refreshOnShow: false });
  const refetch = useRefetch(appsCardQuery);
  const refresh = useRefresh(appsCardQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  const [armed, setArmed] = useState<{ app: string; action: AppAction; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const posting = useRef(false);
  const [text, setText] = useState('');
  const retry = async (app: string) => {
    if (posting.current || !active) return;
    posting.current = true; setBusy(true); setArmed(null);
    try {
      const token = getMutationToken();
      if (!token) throw new VerseControlLockedError();
      const result = await apiPost<{ app: string; action: string; outcome: string }>('/api/verse/fleet/apps/action', { app, action: 'ensure' }, token);
      if (!result || result.app !== app || result.action !== 'ensure' || !['already_running', 'launched'].includes(result.outcome)) throw new Error('Invalid app response.');
      touchMutationHold(); setText(`${app}: recovery — ${result.outcome}`);
    } catch (error) { setText(appActionFailureText(error)); }
    finally { posting.current = false; setBusy(false); refresh(); refreshRecovery(); }
  };
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), APP_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  useEffect(() => { if (!active) setArmed(null); }, [active]);
  const press = async (app: string, action: AppAction) => {
    if (posting.current || !active) return;
    if (!armed || armed.app !== app || armed.action !== action || Date.now() - armed.at >= APP_CONFIRM_MS) {
      setArmed({ app, action, at: Date.now() }); setText(''); return;
    }
    posting.current = true;
    setArmed(null); setBusy(true);
    try { setText(appActionOutcomeText(await postAppAction(app, action))); }
    catch (error) { setText(appActionFailureText(error)); }
    finally { posting.current = false; setBusy(false); refresh(); }
  };
  if (read.data === null) return null;
  return <section className={styles.section} aria-label="Managed apps">
    <h3 className={styles.title}>Managed apps</h3>
    {!read.data ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Managed apps are unavailable.' : 'Reading managed apps…'}</p>
      : !read.data.available ? <p className={styles.muted}>App control needs a Phantom source checkout.</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Managed apps could not refresh. Showing the last reading.</p> : null}
        <ul>{appRows(read.data).map((row) => { const recoveryRow = appRecoveryRow(recovery.status === 'error' ? null : recovery.data, row.app); return <li className={styles.line} key={row.app}>
          <div><span>{row.app}: {row.state}</span>
          <p className={styles.muted} data-tone={recoveryRow.tone}>{recoveryRow.label}{recoveryRow.ageText ? ` · ${recoveryRow.ageText}` : ''}</p></div>
          <div className={styles.actions}>{recoveryRow.canRetry ? <Button size="sm" disabled={busy || !active} aria-label={`Retry recovery ${row.app}`} onClick={() => { void retry(row.app); }}>Retry recovery</Button> : null}{appActionsFor(row).map((action) => <Button size="sm" key={action}
            disabled={busy || !active} aria-label={`${action} ${row.app}`}
            onClick={() => { void press(row.app, action); }}>
            {appActionConfirmLabel(row.app, action, armed?.app === row.app && armed.action === action)}
          </Button>)}</div>
        </li>; })}</ul>
      </>}
    {text ? <p className={styles.line} role="status">{text}</p> : null}
  </section>;
}
