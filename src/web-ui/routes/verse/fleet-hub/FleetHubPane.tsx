import { Fragment, useMemo, useState } from 'react';
import { StatusBadge, Tag } from '../../../components/primitives/index.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane, openFleetWorkspace } from '../dock/dock-store.js';
import { agentBusMissing, agentBusPageQuery, agentBusStatusQuery } from '../fleet-bus/agent-bus-queries.js';
import { parseInboxAt } from '../fleet/interject-ack-model.js';
import { relativeText } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { usePanes, type PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { pairedDevicesQuery } from '../sections/paired-devices-query.js';
import { pendingPhonesQuery } from '../sections/pending-phones-query.js';
import { setVerseSection } from '../verse-ui-store.js';
import { curatedWorkspace, hubEmptyState, hubTiles, snapshotAge } from './fleet-hub-model.js';
import { lastOrderLine } from './hub-last-order.js';
import { busTile } from './hub-bus-tile.js';
import { phoneTile } from './hub-phone-tile.js';
import { hubBacklogQuery } from './hub-backlog-queries.js';
import { backlogTile } from './hub-backlog-tile.js';
import styles from './fleet-hub.module.css';

export function FleetHubPane({ visible }: Pick<PaneProps, 'visible'>) {
  const [copyLabel, setCopyLabel] = useState('Copy command');
  const panes = usePanes();
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(opsRunsQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const backlogRead = useQuery(hubBacklogQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 60_000 });
  const refreshBacklog = useRefetch(hubBacklogQuery);
  usePollWhileVisible(refreshBacklog, 60_000, { enabled: visible });
  const busEnabled = visible && sectionVisible && documentVisible && !agentBusMissing();
  const status = useQuery(agentBusStatusQuery, { enabled: busEnabled, freshMs: 15_000 });
  const after = Math.max(0, (status.data?.retainedCount ?? 0) - 100);
  const pageQuery = useMemo(() => agentBusPageQuery(after, 100), [after]);
  const pageEnabled = busEnabled && status.data?.source === 'available' && status.data.retainedCount !== null;
  const page = useQuery(pageQuery, { enabled: pageEnabled, freshMs: 15_000 });
  const refreshStatus = useRefetch(agentBusStatusQuery);
  const refreshPage = useRefetch(pageQuery);
  usePollWhileVisible(() => {
    if (!agentBusMissing()) { refreshStatus(); if (pageEnabled) refreshPage(); }
  }, 15_000, { enabled: visible && !agentBusMissing() });
  const phoneEnabled = visible && sectionVisible && documentVisible;
  const devices = useQuery(pairedDevicesQuery, { enabled: phoneEnabled, freshMs: 15_000 });
  const pending = useQuery(pendingPhonesQuery, { enabled: phoneEnabled, freshMs: 15_000 });
  const refreshDevices = useRefetch(pairedDevicesQuery);
  const refreshPending = useRefetch(pendingPhonesQuery);
  usePollWhileVisible(() => { refreshDevices(); refreshPending(); }, 15_000, { enabled: visible });
  const missingBus = agentBusMissing() || [status.error, page.error].some(error => error instanceof ApiError && error.status === 404);
  const bus = missingBus
    ? { title: 'Bus', reading: 'Update the hub for the durable bus', caption: 'Store status unknown', tone: 'unknown' as const }
    : status.status === 'error' && !status.data
      ? { title: 'Bus', reading: 'Durable bus unavailable', caption: 'Store status unknown', tone: 'unknown' as const }
      : busTile(status.data ?? null, page.status === 'error' ? null : page.data?.messages ?? null, Date.now());
  const tiles = hubTiles(read.data ?? null, panes);
  const presentIds = tiles.filter((tile) => tile.present).map((tile) => tile.id);
  const workspaceIds = curatedWorkspace(presentIds);
  const empty = hubEmptyState(read.data ?? null);
  const now = Date.now();
  const phone = devices.data && 'kind' in devices.data ? null
    : devices.status === 'error' || pending.status === 'error'
      ? { title: 'Phone', reading: 'Phone status unavailable', detail: 'Phone status unavailable.', tone: 'warn' as const }
      : phoneTile(devices.data ?? null, pending.data ?? null, now);
  const backlog = backlogTile(backlogRead.data, now);
  const backlogButton = backlog && <button type="button" className={styles.tile} data-tone={backlog.tone} onClick={() => openDockPane('fleet-merges')}>
    <strong>Merge backlog</strong>
    <span className={styles.count}>{backlog.text}</span>
    <span className={styles.count}>{backlog.detail}{backlog.stale ? ' · stale' : ''}</span>
  </button>;
  const lastOrder = lastOrderLine(read.data ?? null, now);
  const orderAt = lastOrder ? parseInboxAt(lastOrder.at, now) : null;
  const runsDir = read.data && 'runsDir' in read.data && typeof read.data.runsDir === 'string' && read.data.runsDir.trim()
    ? read.data.runsDir : '~/.ashlr-runs';

  return <section className={styles.pane} aria-label="Fleet">
    <button type="button" className={styles.primary} disabled={workspaceIds.length === 0} onClick={() => openFleetWorkspace(workspaceIds)}>Open fleet workspace</button>
    <button type="button" className={styles.secondary} disabled={presentIds.length === 0} onClick={() => openFleetWorkspace(presentIds)}>Open all fleet panes</button>
    {read.status === 'error' ? <p role="status">Fleet counts are unavailable. Showing the last reading.</p> : null}
    <p role="status" className={styles.count}>{snapshotAge(read.data?.generatedAt ?? null, Date.now())}</p>
    {empty?.kind === 'no-fleet' ? <div className={styles.empty} data-empty="no-fleet" role="status">
      <strong>No fleet on this Mac yet</strong>
      <p>Phantom looks for fleet runs in <code>{runsDir}</code>.</p>
      <code>ashlr fleet init</code>
      <button type="button" className={styles.secondary} onClick={() => { void copyText('ashlr fleet init').then((copied) => setCopyLabel(copied ? 'Copied' : 'Copy failed')); }}>{copyLabel}</button>
    </div> : null}
    {lastOrder && <div className={styles.lastOrder}>
      <span><strong>Your last order</strong> · <Tag>{lastOrder.sourceLabel}</Tag> · {relativeText(orderAt === null ? null : new Date(orderAt).toISOString(), now)}: {lastOrder.excerpt}</span>
      <StatusBadge status={lastOrder.ack} tone={lastOrder.tone}>{lastOrder.label}</StatusBadge>
      <button type="button" className={styles.orderButton} onClick={() => openDockPane('fleet-inbox')}>Open inbox</button>
    </div>}
    <div className={styles.tiles}>
      {empty?.kind !== 'no-fleet' && tiles.map((tile) => <Fragment key={tile.id}><button type="button" className={styles.tile} data-tone={tile.tone} disabled={!tile.present} onClick={() => openDockPane(tile.id)}>
        <strong>{tile.title}</strong>
        <span className={styles.count}>{tile.count}</span>
        {!tile.present ? <span>not in this build</span> : null}
      </button>{tile.id === 'fleet-merges' ? backlogButton : null}</Fragment>)}
      {empty?.kind === 'no-fleet' ? backlogButton : null}
      <button type="button" className={styles.tile} data-tone={bus.tone}
        style={{ borderColor: bus.tone === 'warn' ? 'var(--status-warning-solid)' : bus.tone === 'bad' ? 'var(--status-danger-solid)' : undefined }}
        onClick={() => openDockPane('fleet-bus')}>
        <strong>{bus.title}</strong>
        <span className={styles.count}>{bus.reading}</span>
        <span className={styles.count}>{bus.caption}</span>
      </button>
      {phone && <button type="button" className={styles.tile} data-tone={phone.tone} title={phone.detail}
        onClick={() => setVerseSection('settings', 'fleet-sources')}>
        <strong>{phone.title}</strong>
        <span className={styles.count}>{phone.reading}</span>
      </button>}
    </div>
  </section>;
}
