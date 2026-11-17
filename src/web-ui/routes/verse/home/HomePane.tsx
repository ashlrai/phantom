/** Home: the `phm home` summary (plus the `phm releases` card) as one column of plain cards. Each card has one action, which opens the existing detailed view. */
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { openDockPane } from '../dock/dock-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { setFocusMode } from '../shell/focus-mode.js';
import { setHomeChoice } from '../shell/home-view-store.js';
import { readLastSeen } from '../shell/last-seen-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { setVerseSection } from '../verse-ui-store.js';
import { Card, Value } from './home-card.js';
import styles from './home.module.css';
import { ReleasesCard } from './ReleasesCard.js';

// Unread is counted against this window's own last-read time, the same one the Leader chip uses.
const query: QueryDef<HomeSummary> = { key: 'fleet-home', fetch: signal => apiGet(`/api/verse/fleet/runs/home?leaderSeen=${readLastSeen().leader}`, signal) };
const openPane = (paneId: string) => { setFocusMode(false); setVerseSection('chat'); openDockPane(paneId); };

export function HomePane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  // Any other payload (an older server, an error body) is not a summary.
  const home = read.data?.schema === 'home.v1' ? read.data : null;
  if (!home) return <section className={styles.root} aria-label="Home"><p className={styles.headline}>{read.status === 'error' || read.data ? 'Fleet health: unknown (the summary could not be read).' : 'Reading fleet health…'}</p></section>;
  return <section className={styles.root} aria-label="Home">
    <p className={styles.headline} data-health={home.health}>{home.headline}</p>
    <Card title="Merged PRs" action="Open Throughput" onOpen={() => openPane('fleet-throughput')}>
      <p>Last hour: <Value field={home.mergedLastHour}>{String}</Value></p>
      <p>Last 24 hours: <Value field={home.merged24h}>{String}</Value></p>
      <p>Median time to merge: <Value field={home.medianMergeSeconds}>{seconds => seconds < 90 ? `${Math.round(seconds)} seconds` : `${Math.round(seconds / 60)} minutes`}</Value></p>
    </Card>
    <Card title="Main" action="Open Fleet" onOpen={() => setVerseSection('fleet')}>
      <Value field={home.main}>{repos => <ul>{repos.map(repo => <li key={repo.repo}>{repo.repo}: {repo.state}</li>)}</ul>}</Value>
    </Card>
    <ReleasesCard visible={visible} />
    <Card title="Running jobs" action="Open Lanes" onOpen={() => openPane('fleet-lanes')}>
      <Value field={home.running}>{lanes => <ul>{lanes.map(lane => <li key={lane.lane}>{lane.lane}: {lane.running}{lane.target === null ? '' : ` of ${lane.target}`}</li>)}</ul>}</Value>
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
  </section>;
}
