/** Home: the Pulse card (`phm fleet pulse`) on top, then the `phm home` summary as one column of plain cards. Each card has one action, which opens the existing detailed view (the Pools card is a bar of pool tiles above its action); the Approvals card (`phm approvals`) leads when Mason is needed, the From your leader card (`phm leader replies`) follows it, the Working now card (`phm sessions`) lists each live session, and the Disk card (`phm worktrees`) closes the column.
 * The headline carries a state mark and the time the summary was read; lanes with a target and repos draw their reading (a bar, a mark) beside the same words. */
import type { ReactNode } from 'react';
import type { HomeField, HomeSummary } from '../../../../core/fleet/home.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { openDockPane } from '../dock/dock-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { setFocusMode } from '../shell/focus-mode.js';
import { setHomeChoice } from '../shell/home-view-store.js';
import { readLastSeen } from '../shell/last-seen-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { setVerseSection } from '../verse-ui-store.js';
import { ApprovalsCard } from './ApprovalsCard.js';
import { DeliveryCard } from './DeliveryCard.js';
import { DiskCard } from './DiskCard.js';
import { MachinesCard } from './MachinesCard.js';
import { LeaderRepliesCard } from './LeaderRepliesCard.js';
import { PoolsCard } from './PoolsCard.js';
import { PulseCard } from './PulseCard.js';
import { PulseStrip } from './PulseStrip.js';
import { FleetShippedCard } from './FleetShippedCard.js';
import { ThisMacCard } from './ThisMacCard.js';
import { WorkingNowCard } from './WorkingNowCard.js';
import { MainRepos, RunningLanes } from './HomeReadings.js';
import styles from './home.module.css';

// Unread is counted against this window's own last-read time, the same one the Leader chip uses.
const query: QueryDef<HomeSummary> = { key: 'fleet-home', fetch: signal => apiGet(`/api/verse/fleet/runs/home?leaderSeen=${readLastSeen().leader}`, signal) };
const openPane = (paneId: string) => { setFocusMode(false); setVerseSection('chat'); openDockPane(paneId); };

const openPoolJob = (job: string) => { requestWorkerLogJob(job); openPane('worker-log'); };
const openPools = () => openPane('fleet-pools');
// What each session is doing, on its own read like Approvals: keyed so the list survives the summary arriving.
const working = (visible: boolean) => <WorkingNowCard key="working-now" visible={visible} onOpenJob={openPoolJob} onOpenSessions={() => openPane('fleet-sessions')} />;

/** The summary's own read time. An unparseable stamp is no time at all, never "now". */
function readAt(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function Value<T>({ field, children }: { field: HomeField<T>; children: (value: T) => ReactNode }) {
  return field.state === 'ok' ? <>{children(field.value)}</> : <span data-unknown>Unknown: {field.reason}</span>;
}
function Card({ title, action, onOpen, children }: { title: string; action: string; onOpen: () => void; children: ReactNode }) {
  return <section className={styles.card} aria-label={title}><h3>{title}</h3>{children}<button type="button" className={styles.action} onClick={onOpen}>{action}</button></section>;
}

export function HomePane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  // Any other payload (an older server, an error body) is not a summary.
  const home = read.data?.schema === 'home.v1' ? read.data : null;
  // Approvals come first and stand on their own API: what only Mason can do should not wait on the health summary.
  if (!home) return <section className={styles.root} aria-label="Home"><PulseStrip visible={visible} /><PulseCard visible={visible} /><p className={styles.headline}>{read.status === 'error' || read.data ? 'Fleet health: unknown (the summary could not be read).' : 'Reading fleet health…'}</p><ApprovalsCard key="approvals" visible={visible} /><LeaderRepliesCard key="leader-replies" visible={visible} />{working(visible)}<PoolsCard key="pools" visible={visible} onOpenJob={openPoolJob} onOpenPools={openPools} /><MachinesCard key="machines" visible={visible} className={styles.card} onOpenJob={openPoolJob} /></section>;
  // A failed refresh keeps the last summary on screen; it must not read as current.
  const stale = read.status === 'error';
  const at = readAt(home.asOf);
  return <section className={styles.root} aria-label="Home">
    <PulseStrip visible={visible} /><PulseCard visible={visible} />
    <p className={styles.headline} data-health={home.health}>{home.headline}</p>
    <p className={styles.asOf} data-stale={stale || undefined} role={stale ? 'status' : undefined}>
      {stale ? 'Could not refresh. Showing the reading from ' : 'As of '}{at ? <time dateTime={home.asOf}>{at}</time> : 'an unknown time'}.</p>
    {/* Keyed like the loading branch above: the read-time line sits before these cards only here, and an open pool or a half-given answer must survive the summary arriving. */}
    <ApprovalsCard key="approvals" visible={visible} />
    <LeaderRepliesCard key="leader-replies" visible={visible} />
    {working(visible)}
    <PoolsCard key="pools" visible={visible} onOpenJob={openPoolJob} onOpenPools={openPools} />
    <MachinesCard key="machines" visible={visible} className={styles.card} onOpenJob={openPoolJob} />
    <ThisMacCard visible={visible} className={styles.card} />
    {/* The day's merges drawn by the hour, on the Throughput pane's own 24 hour read. */}
    <DeliveryCard summary={home} visible={visible} onOpen={() => openPane('fleet-throughput')} />
    <Card title="Main" action="Open Fleet" onOpen={() => setVerseSection('fleet')}>
      <Value field={home.main}>{repos => <MainRepos repos={repos} />}</Value>
    </Card>
    <Card title="Running jobs" action="Open Lanes" onOpen={() => openPane('fleet-lanes')}>
      <Value field={home.running}>{lanes => <RunningLanes lanes={lanes} />}</Value>
    </Card>
    <Card title="Most at risk of going unused" action="Open Usage" onOpen={() => openPane('fleet-usage')}>
      <p><Value field={home.atRisk}>{risk => risk ? `${risk.resource}. ${risk.reason}` : 'Nothing is set to expire unused.'}</Value></p>
    </Card>
    <Card title="Work log" action="Open Work log" onOpen={() => { window.location.hash = '#/work/log'; }}>
      <Value field={home.worklog}>{rows => rows.length ? <ul>{rows.map(row => <li key={`${row.at} ${row.text}`}>
        <time dateTime={row.at}>{new Date(row.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time> {row.text}</li>)}</ul>
        : <p>No work recorded in the last 24 hours.</p>}</Value>
    </Card>
    <Card title="Leader" action="Open Leader" onOpen={() => setHomeChoice('leader')}>
      <p><Value field={home.unreadLeaderReplies}>{n => n === 0 ? 'No unread replies.' : n === 1 ? '1 unread reply.' : `${n} unread replies.`}</Value></p>
    </Card>
    <FleetShippedCard visible={visible} onOpenJob={openPoolJob} />
    <DiskCard visible={visible} />
  </section>;
}
