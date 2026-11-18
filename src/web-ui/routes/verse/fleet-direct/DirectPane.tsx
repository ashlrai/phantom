import { useMemo } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { nodesQuery } from '../../fleet-dashboard/NodesPanel.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fleetUsageRunsQuery } from '../fleet-usage/fleet-usage-queries.js';
import { opsReleasesQuery } from '../fleet-releases/fleet-releases-queries.js';
import { rosterQuery } from '../fleet-org/OrgPane.js';
import { DirectBox } from './DirectBox.js';
import { buildLivePanels, type LivePanel } from './live-panels-model.js';
import styles from './fleet-direct.module.css';

const POLL_MS = 10_000;

function Panel({ panel }: { panel: LivePanel }) {
  return <section className={styles.panel} aria-label={panel.title} data-state={panel.state}>
    <h3 className={styles.title}>{panel.title}</h3>
    <p className={styles.headline} role={panel.state === 'error' ? 'alert' : undefined}>{panel.headline}</p>
    {panel.rows.length > 0 && <dl className={styles.rows}>
      {panel.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>}
  </section>;
}

export function DirectPane({ visible }: PaneProps) {
  const runs = useQuery(fleetUsageRunsQuery, { enabled: visible, freshMs: 0 });
  const releases = useQuery(opsReleasesQuery, { enabled: visible, freshMs: 0 });
  const nodes = useQuery(nodesQuery, { enabled: visible, freshMs: 0 });
  const roster = useQuery(rosterQuery, { enabled: visible, freshMs: 0 });
  const refetch = [useRefetch(fleetUsageRunsQuery), useRefetch(opsReleasesQuery), useRefetch(nodesQuery), useRefetch(rosterQuery)];
  usePollWhileVisible(() => refetch.forEach(r => r()), POLL_MS, { enabled: visible });

  const loading = [runs, releases, nodes, roster].some(q => q.data === undefined && q.status !== 'error');
  const panels = useMemo(() => buildLivePanels({
    runs: runs.data, releases: releases.data ?? null, nodes: nodes.data ?? null, roster: roster.data,
  }), [runs.data, releases.data, nodes.data, roster.data]);
  return <div className={styles.root}>
    <DirectBox />
    {loading ? <p className={styles.quiet} role="status">Reading the fleet…</p>
      : <div className={styles.grid}>{panels.map(p => <Panel key={p.id} panel={p} />)}</div>}
  </div>;
}
