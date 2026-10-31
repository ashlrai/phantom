import { useId } from 'react';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { runQuery } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import { useNow } from '../autonomy/use-ticker.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { laneShort } from './lane-label.js';
import { headerText, laneFill, laneNote, sortLanes } from './runs-lanes-model.js';
import { runsLanesQuery } from './runs-lanes-queries.js';
import { tickStaleness } from './tick-staleness.js';
import { notInBuild } from './workers-card-queries.js';
import styles from './runs-lanes.module.css';

export function RunsLanesCard() {
  const id = useId();
  const read = useQuery(runsLanesQuery);
  const now = useNow();
  usePollWhileVisible(() => { void runQuery(runsLanesQuery.key, () => runsLanesQuery.fetch()); }, 5_000, { enabled: !notInBuild(read.error) });
  const data = read.data;
  return <section className={styles.panel} aria-labelledby={id}>
    <header className={styles.header}><h2 id={id}>Lanes on this Mac</h2>
      {data ? <span data-level={tickStaleness(data.lastTick, now).level}>{headerText(data, now)}</span> : null}
    </header>
    {data && data.sources.runsDir !== 'healthy' ? <StatusBadge status="degraded">runs directory {data.sources.runsDir}</StatusBadge> : null}
    {read.error ? <EmptyState compact title="Lane refresh unavailable" body={notInBuild(read.error) ? 'The runs API is not in this build yet.' : 'Unable to read live lanes. Any rows below are from the last successful read.'} /> : null}
    {read.status === 'loading' ? <SkeletonLine /> : data ? data.lanes.length === 0 ? <p>No lanes reported on this Mac.</p>
      : <div className={styles.scroll}><table><thead><tr>{['Lane', 'Running/Target', 'Queued', 'Tokens 1h', 'Merged 24h', 'Note'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{sortLanes(data.lanes).map(lane => <tr key={lane.lane}>
          <th scope="row" title={lane.lane}>{laneShort(lane.lane)}</th><td>{laneFill(lane)}</td><td>{lane.queued}</td>
          <td>{lane.tokensLastHour ?? '—'}</td><td>{lane.merged24h ?? '—'}</td><td>{laneNote(lane) ?? '—'}</td>
        </tr>)}</tbody></table></div> : null}
  </section>;
}
