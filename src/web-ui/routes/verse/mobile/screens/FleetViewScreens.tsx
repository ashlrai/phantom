/**
 * routes/verse/mobile/screens/FleetViewScreens.tsx — Spend down, Pool runway,
 * Held work, Library and Message graph on the phone (Goals has its own screen).
 *
 * Nothing here has data logic of its own. Spend down, Pool runway and Library
 * ARE the desktop components (they already stack at phone width); Held work
 * and Message graph read the desktop's typed queries and print one Row each.
 * A reading the Mac did not give stays "unknown" — never zero, never blank.
 */
import { useState } from 'react';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { fleetMessageGraphQuery } from '../../../control/fleet/fleet-map-queries.js';
import { formatRelative } from '../../autonomy/format.js';
import { PoolsCard } from '../../home/PoolsCard.js';
import { LibraryOverview } from '../../library/LibraryOverview.js';
import { opsRunsQuery } from '../../ops/ops-runs-queries.js';
import { SpendDown } from '../../resources/SpendDown.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { useMobile } from '../mobile-context.js';
import { Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Row, Section } from '../ui-parts.js';
import styles from '../FleetViewScreens.module.css';

/** Every view's own screen: a title, a Back to More, and the content. */
function ViewScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const { navigate } = useMobile();
  return (
    <Screen title={title} onBack={() => navigate({ screen: 'more' })} backLabel="More" label={title}>
      {children}
    </Screen>
  );
}

export function SpendScreen() {
  return <ViewScreen title="Spend down"><div className={styles.wrap}><SpendDown /></div></ViewScreen>;
}

export function PoolRunwayScreen() {
  const { navigate } = useMobile();
  return <ViewScreen title="Pool runway"><div className={styles.wrap}><PoolsCard onOpenJob={(job) => navigate({ screen: 'worker', job })} /></div></ViewScreen>;
}

export function LibraryScreen() {
  const [search, setSearch] = useState('');
  return (
    <ViewScreen title="Library">
      <div className={styles.wrap}>
        {isRemoteMobileMode()
          ? <EmptyState title="The Library is not available through the gateway." body="Open Phantom on your Mac's network to read it." />
          : <>
            <LibraryOverview visible search={search} onSearch={setSearch} />
            <p className={styles.note}>Reading the Library needs actions unlocked: More, then Unlock.</p>
          </>}
      </div>
    </ViewScreen>
  );
}

export function HeldScreen() {
  const query = useQuery(opsRunsQuery, { freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 30_000);
  const now = Date.now();
  const held = query.data?.notRunning;
  let body;
  if (query.status === 'error' && query.data === undefined) body = <ErrorState title="Couldn’t read held work" reason={readFailureReason(query.error)} onRetry={refetch} />;
  else if (query.data === undefined) body = <SkeletonList rows={3} label="Loading held work" />;
  else if (query.data === null) body = <EmptyState title="Not in this build yet." body="This Mac does not report held work." />;
  else if (!held) body = <EmptyState title="Held work is unknown." body="This Mac did not say what is held. Nothing is assumed." />;
  else if (held.length === 0) body = <EmptyState title="Nothing is held." body="Every launch and lane is running or has finished." />;
  else {
    body = (
      <Section title={`${held.length} not running`} footer="Same list as `phm fleet held`.">
        {held.map((row) => (
          <Row
            key={`${row.kind}:${row.job_or_lane}`}
            title={row.job_or_lane}
            subtitle={<>{row.reason}<br />Next: {row.unblock}</>}
            trailing={<Badge tone="warning">{formatRelative(row.since, now)}</Badge>}
          />
        ))}
      </Section>
    );
  }
  return <ViewScreen title="Held work">{body}</ViewScreen>;
}

export function MessageGraphScreen() {
  const query = useQuery(fleetMessageGraphQuery, { freshMs: 0 });
  const refetch = useRefetch(fleetMessageGraphQuery);
  usePollWhileVisible(refetch, 60_000);
  const now = Date.now();
  const graph = query.data;
  let body;
  if (!graph && query.status === 'error') body = <ErrorState title="Couldn’t read the message graph" reason={`${readFailureReason(query.error)} The counts are unknown, not zero.`} onRetry={refetch} />;
  else if (!graph) body = <SkeletonList rows={3} label="Loading the message graph" />;
  else if (graph.groups.length === 0) body = <EmptyState title="No messages yet." body={`No agent messages since ${formatRelative(graph.since, now).replace(/ ago$/, '')} ago.`} />;
  else {
    body = graph.groups.map((group) => (
      <Section key={group.id} title={`${group.from} to ${group.to}`} trailing={<Badge tone="neutral">{group.count}</Badge>} footer={`Last ${formatRelative(group.lastAt, now)}`}>
        {group.edges.map((edge) => <Row key={edge.id} title={`${edge.from} to ${edge.to}`} subtitle={`Last ${formatRelative(edge.lastAt, now)}`} trailing={edge.count} />)}
      </Section>
    ));
  }
  return <ViewScreen title="Message graph">{body}</ViewScreen>;
}
