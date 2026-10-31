import { useState } from 'react';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { fleetBriefText } from './fleet-brief-model.js';
import styles from './fleet-brief.module.css';

export function FleetBriefPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(opsRunsQuery, { enabled: active, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  const [notice, setNotice] = useState('');
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  const text = read.data ? fleetBriefText(read.data, Date.now()) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied');
    } catch {
      setNotice('Copy failed');
    }
  };
  return <div className={styles.pane} aria-label="Fleet brief">
    <div className={styles.actions}>
      <button type="button" onClick={() => void copy()} disabled={!text}>Copy</button>
      <button type="button" onClick={refresh}>Refresh</button>
      <span role="status">{notice}</span>
    </div>
    {read.data === null ? <p>The fleet runs API has not landed in this build yet.</p>
      : !read.data ? <p role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        <textarea aria-label="Fleet brief text" readOnly value={text} rows={12} />
      </>}
  </div>;
}
