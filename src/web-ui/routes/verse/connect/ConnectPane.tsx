/**
 * routes/verse/connect/ConnectPane.tsx: one list of everything the fleet can
 * plug into, grouped by kind, with a search box, a state dot per row and a
 * switch where an enable/disable route exists. Rows, order, states and next
 * steps all come from GET /api/connect (phantom.connect.v1), the same list
 * `phm connect list --json` prints, so the pane decides nothing an agent
 * cannot read. The switch calls the Connectors settings route; rows without
 * one show their next step instead. No credential reaches this pane: a row
 * that needs one only says "needs sign-in".
 */
import { useState } from 'react';
import {
  CONNECT_KIND_LABEL, CONNECT_KINDS, CONNECT_PATH, CONNECT_SCHEMA, CONNECT_STATES,
  type ConnectList, type ConnectRow, type ConnectState,
} from '../../../../core/fleet/connect-schema.js';
import { apiGet } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { changeConnector } from '../../settings/connectors/connectors-client.js';
import { CopyPill } from '../apps/CopyPill.js';
import { formatRelative } from '../autonomy/format.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './connect.module.css';

export const connectQuery: QueryDef<ConnectList> = {
  key: 'connect-list',
  fetch: async (signal) => {
    const data = await apiGet<ConnectList>(CONNECT_PATH, signal);
    // A drifted payload is loud, not a blank list.
    if (data?.schema !== CONNECT_SCHEMA || !Array.isArray(data.rows)) throw new Error(`Expected ${CONNECT_SCHEMA}`);
    return data;
  },
};

const STATE_LABEL: Record<ConnectState, string> = { on: 'On', off: 'Off', broken: 'Broken', unknown: 'Unknown' };

function lastUsed(value: ConnectRow['lastUsed'], nowMs: number): string {
  return value === null ? 'never' : value === 'unknown' ? 'unknown' : formatRelative(value, nowMs);
}

const matches = (row: ConnectRow, words: string[]): boolean => {
  const hay = [row.name, row.source, row.kind, row.state, ...row.users, row.needsSignIn ? 'needs sign-in' : ''].join(' ').toLowerCase();
  return words.every(word => hay.includes(word));
};

function Row({ row, nowMs, canChange, busy, onToggle }: { row: ConnectRow; nowMs: number; canChange: boolean; busy: boolean; onToggle: (row: ConnectRow) => void }) {
  const command = row.next ? /`([^`]+)`/.exec(row.next)?.[1] ?? null : null;
  return <li className={styles.row} data-state={row.state} aria-label={`${row.name}: ${STATE_LABEL[row.state]}`}>
    <span className={styles.dot} aria-hidden="true" />
    <div className={styles.body}>
      <div className={styles.head}>
        <strong className={styles.name}>{row.name}</strong>
        <span className={styles.state}>{STATE_LABEL[row.state]}</span>
        {row.needsSignIn ? <span className={styles.tag}>needs sign-in</span> : null}
      </div>
      <p className={styles.meta}>{row.source} · Used by {row.users.join(', ') || 'no one named'} · Last used {lastUsed(row.lastUsed, nowMs)}</p>
      {row.next ? <p className={styles.next} data-testid="connect-next">
        <span>Next: {row.next.replace(/`/g, '')}</span>
        {command ? <CopyPill text={command} label="Copy" what={`the ${row.name} next step`} /> : null}
      </p> : null}
    </div>
    {row.toggle ? <button type="button" role="switch" className={styles.switch} aria-checked={row.state === 'on'}
      aria-label={`${row.name} on`} disabled={!canChange || busy} onClick={() => onToggle(row)}><span aria-hidden="true" /></button> : null}
  </li>;
}

export function ConnectPane({ visible }: PaneProps) {
  const read = useQuery(connectQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(connectQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });
  const { hasHold } = useMutationHold();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const view = read.data;
  if (!view) return <p className={styles.message} role="status">{read.status === 'error' ? 'Connect is unavailable.' : 'Reading what is plugged in…'}</p>;

  async function toggle(row: ConnectRow) {
    if (!row.toggle || busy) return;
    setBusy(true);
    setMessage('');
    const turnOn = row.state !== 'on';
    try {
      await changeConnector({ name: row.name, enabled: !turnOn }, row.toggle.revision);
      setMessage(`${row.name} is ${turnOn ? 'on' : 'off'}. Restart gateway clients to apply it.`);
    } catch {
      setMessage(`${row.name} did not change. Refresh and try again.`);
    } finally { setBusy(false); refetch(); }
  }

  const nowMs = Date.now();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = view.rows.filter(row => matches(row, words));
  const groups = CONNECT_KINDS.map(kind => ({ kind, rows: shown.filter(row => row.kind === kind), unread: view.unread.includes(kind) }))
    .filter(group => group.rows.length > 0 || (group.unread && words.length === 0));
  return <section className={styles.root} aria-label="Connect">
    <p className={styles.headline}>{CONNECT_STATES.map(state => `${view.counts[state]} ${state}`).join(' · ')}.</p>
    {read.status === 'error' ? <p className={styles.message} role="alert">Could not refresh. Showing the last reading.</p> : null}
    <input type="search" className={styles.search} aria-label="Search" placeholder="Search by name, kind, state or lane"
      value={search} onChange={event => setSearch(event.target.value)} />
    {view.rows.some(row => row.toggle) && !hasHold ? <p className={styles.message}>Unlock actions in Connection to use the switches.</p> : null}
    {groups.length === 0 ? <p className={styles.message}>{view.rows.length === 0 ? 'Nothing is plugged in yet.' : 'Nothing matches that search.'}</p> : null}
    {groups.map(group => <section key={group.kind} className={styles.group} aria-label={CONNECT_KIND_LABEL[group.kind]}>
      <h3 className={styles.kind}>{CONNECT_KIND_LABEL[group.kind]} <span className={styles.count}>{group.rows.length}</span></h3>
      {group.unread ? <p className={styles.message}>Some {CONNECT_KIND_LABEL[group.kind].toLowerCase()} could not be read: unknown.</p> : null}
      <ul className={styles.list}>{group.rows.map(row => <Row key={row.id} row={row} nowMs={nowMs} canChange={hasHold} busy={busy} onToggle={(r) => { void toggle(r); }} />)}</ul>
    </section>)}
    <p className={styles.message} role="status">{message}</p>
    <p className={styles.message}>No credential is shown here. Same data: <code>phm connect list --json</code>.</p>
  </section>;
}
