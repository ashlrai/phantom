import { useRef, useState } from 'react';
import type { AppsActionReport } from '../../../../core/apps-control.js';
import { lastUsedText } from '../../../../core/apps-last-used.js';
import type { MacAppRow, MacAppsReport } from '../../../../core/apps-known.js';
import { Button } from '../../../components/primitives/index.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import styles from './fleet-host.module.css';

const READ_PATH = '/api/verse/apps/mac';
const ACT_PATH = '/api/verse/apps/control';

const isRow = (r: unknown): r is MacAppRow => {
  const row = r as Partial<MacAppRow> | null;
  return !!row && typeof row.id === 'string' && typeof row.name === 'string'
    && (row.action === null || row.action === 'open' || row.action === 'focus');
};

export const macAppsQuery = { key: 'mac-apps', fetch: async (signal?: AbortSignal) => {
  const data = await apiGet<MacAppsReport>(READ_PATH, signal);
  if (!data || data.schema !== 'phm.apps/2' || !Array.isArray(data.apps) || !data.apps.every(isRow)) throw new Error('Invalid apps response');
  return data;
} };

/** Plain state for one row; unknown stays unknown. */
export function macAppState(row: MacAppRow): string {
  if (row.installed === null) return 'Unknown';
  if (!row.installed) return 'Not installed';
  if (row.running === null) return 'Installed · running unknown';
  if (!row.running) return 'Not running';
  const memory = row.memoryMb === null ? '' : ` · ${row.memoryMb >= 1024 ? `${(row.memoryMb / 1024).toFixed(1)} GB` : `${row.memoryMb} MB`}`;
  return `${row.frontmost ? 'In front' : 'Running'}${memory}`;
}

const LABEL = { open: 'Open', focus: 'Bring to front' } as const;
const DID: Record<string, string> = { open: 'Opened', focus: 'Brought to front', quit: 'Quit', restart: 'Restarted' };

/** The last thing Phantom did to the app, in plain words; empty when nothing is on record. */
export function macAppLastAction(row: MacAppRow): string {
  const last = row.lastAction;
  if (!last) return '';
  const time = new Date(last.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return last.outcome === 'done' ? `${DID[last.action] ?? last.action} at ${time}` : `${LABEL[last.action as 'open'] ?? last.action} did not finish at ${time}`;
}

/**
 * Apps on this Mac: the same report as `phm apps --json`, one row per app and
 * at most one button (Open or Bring to front). Actions use `phm apps open|focus`
 * through the shared control API; there is no quit or restart button. Each row also says the
 * last thing Phantom did to the app.
 */
export function MacAppsCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(macAppsQuery, { enabled: active, freshMs: 30_000 });
  const refetch = useRefetch(macAppsQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const posting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const act = async (row: MacAppRow, action: 'open' | 'focus') => {
    if (posting.current || !active) return;
    const token = getMutationToken();
    if (!token) { setMessage('Unlock controls to open apps.'); return; }
    posting.current = true; setBusy(true);
    try {
      const result = await apiPost<AppsActionReport>(ACT_PATH, { app: row.id, action }, token);
      if (result.action !== action || !['done', 'needs-you'].includes(result.outcome)) throw new Error('refused');
      touchMutationHold(); setMessage(`${row.name}: ${result.detail}`);
    } catch { setMessage(`${row.name} did not ${action === 'open' ? 'open' : 'come to the front'}. Refresh and try again.`); }
    finally { posting.current = false; setBusy(false); refetch(); }
  };
  const data = read.data;
  return <section className={styles.section} aria-label="Apps">
    <h3 className={styles.title}>Apps</h3>
    {read.status === 'error' && !data ? <p role="status" className={styles.muted}>App state is unavailable.</p>
      : !data ? <p className={styles.muted}>Reading apps…</p>
      : data.apps.length === 0 ? <p className={styles.muted}>No apps to show.</p>
      : <>
        {data.reason ? <p className={styles.muted}>Some state is unknown: {data.reason}</p> : null}
        {data.apps.every(a => a.installed === false) ? <p className={styles.muted}>None of these apps are installed on this Mac.</p> : null}
        <ul className={styles.appList}>{data.apps.map(row => <li className={styles.appRow} key={row.id}>
          <span className={styles.appName}>{row.name}</span>
          <span className={styles.appState} data-unknown={row.installed === null || row.running === null ? 'true' : undefined}>{macAppState(row)}{macAppLastAction(row) ? ` · ${macAppLastAction(row)}` : ''}</span>
          <span className={styles.appState} data-unknown={row.lastFocus === 'unknown' ? 'true' : undefined} aria-label={`${row.name} last used`}>{row.running ? `Last used: ${lastUsedText(row)}` : ''}</span>
          {row.action ? <Button size="sm" disabled={busy || !active} aria-label={`${LABEL[row.action]} ${row.name}`}
            onClick={() => { void act(row, row.action!); }}>{LABEL[row.action]}</Button> : null}
        </li>)}</ul>
      </>}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
