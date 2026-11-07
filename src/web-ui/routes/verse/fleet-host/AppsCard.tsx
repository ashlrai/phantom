import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_CONFIRM_MS, appActionFailureText, postAppAction } from './apps-action.js';
import { appRows, appActionsFor, appActionConfirmLabel, appActionOutcomeText, type AppAction } from './apps-card-model.js';
import { appsCardQuery } from './apps-card-query.js';
import styles from './fleet-host.module.css';

export function AppsCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(appsCardQuery, { enabled: active, freshMs: 60_000 });
  const refetch = useRefetch(appsCardQuery);
  const refresh = useRefresh(appsCardQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  const [armed, setArmed] = useState<{ app: string; action: AppAction; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const posting = useRef(false);
  const [text, setText] = useState('');
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
        <ul>{appRows(read.data).map((row) => <li className={styles.line} key={row.app}>
          <span>{row.app}: {row.state}</span>
          <div className={styles.actions}>{appActionsFor(row).map((action) => <Button size="sm" key={action}
            disabled={busy || !active} aria-label={`${action} ${row.app}`}
            onClick={() => { void press(row.app, action); }}>
            {appActionConfirmLabel(row.app, action, armed?.app === row.app && armed.action === action)}
          </Button>)}</div>
        </li>)}</ul>
      </>}
    {text ? <p className={styles.line} role="status">{text}</p> : null}
  </section>;
}
