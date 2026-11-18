import { useMemo, useRef, useState } from 'react';
import type { BrowserReport } from '../../../../core/browser-control.js';
import { Button } from '../../../components/primitives/index.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import styles from './fleet-host.module.css';

const PATH = '/api/verse/apps/browser';

export const browserQuery = { key: 'agent-browser', fetch: async (signal?: AbortSignal) => {
  const data = await apiGet<BrowserReport>(PATH, signal);
  if (!data || data.schema !== 'phm.browser/1' || data.action !== 'tabs' || !Array.isArray(data.tabs) || typeof data.detail !== 'string') throw new Error('Invalid browser response');
  return data;
} };

/**
 * Browser: Safari, Phantom's own agent browser. The same report as
 * `phm browser --json`: open agent tabs and the latest screenshot, with one
 * button (`phm browser shot`). Unknown state shows the report's own reason.
 */
export function BrowserCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(browserQuery, { enabled: active, freshMs: 30_000 });
  const refetch = useRefetch(browserQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const shotAt = data?.shot?.at ?? null;
  // One image read per screenshot: the key changes only when a new one is taken.
  const shotQuery = useMemo(() => ({ key: `agent-browser-shot:${shotAt}`, fetch: async (signal?: AbortSignal) => {
    const shot = await apiGet<{ dataUrl?: unknown }>(`${PATH}/shot`, signal);
    if (typeof shot?.dataUrl !== 'string' || !shot.dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid screenshot response');
    return shot.dataUrl;
  } }), [shotAt]);
  const image = useQuery(shotQuery, { enabled: active && shotAt !== null, freshMs: 3_600_000 });
  const posting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const takeShot = async () => {
    if (posting.current || !active) return;
    const token = getMutationToken();
    if (!token) { setMessage('Unlock controls to take a screenshot.'); return; }
    posting.current = true; setBusy(true);
    try {
      const result = await apiPost<BrowserReport>(PATH, { action: 'shot' }, token);
      touchMutationHold(); setMessage(result.ok ? 'Screenshot taken.' : result.detail);
    } catch (error) { setMessage((error as { detail?: string | null }).detail ?? 'The screenshot was not taken. Run phm browser shot to see why.'); }
    finally { posting.current = false; setBusy(false); refetch(); }
  };
  return <section className={styles.section} aria-label="Browser">
    <h3 className={styles.title}>Browser</h3>
    {read.status === 'error' && !data ? <p role="status" className={styles.muted}>Browser state is unavailable.</p>
      : !data ? <p className={styles.muted}>Reading Safari…</p>
      : <>
        <p className={styles.muted} data-unknown={data.running === null ? 'true' : undefined}>{data.running === null ? `Unknown: ${data.detail}` : data.detail}</p>
        {data.tabs!.length ? <ul className={styles.appList}>{data.tabs!.map(tab => <li className={styles.appRow} key={tab.id}>
          <span className={styles.tabTitle}>{tab.title || 'Untitled'}</span>
          <span className={styles.appState}>{tab.url || 'No address'}</span>
        </li>)}</ul> : null}
        {shotAt && image.data ? <figure className={styles.shot}>
          <img src={image.data} alt="Latest Safari screenshot" />
          <figcaption className={styles.muted}>Screenshot from {new Date(shotAt).toLocaleString()}</figcaption>
        </figure> : <p className={styles.muted}>{shotAt ? 'Loading the latest screenshot…' : 'No screenshot yet.'}</p>}
        <div className={styles.actions}>
          <Button size="sm" disabled={busy || !active || !data.running} onClick={() => { void takeShot(); }}>Take screenshot</Button>
        </div>
      </>}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
