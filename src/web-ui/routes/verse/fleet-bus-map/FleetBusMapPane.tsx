import { useMemo } from 'react';
import { SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { busFeedMissing, busFeedQuery } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { buildBusMap, topTalkers, truncateAgentId } from './bus-map-model.js';
import styles from './fleet-bus-map.module.css';

const count = (value: number | null) => value === null ? '—' : value.toLocaleString();
const MAX_AGENTS = 10;
const shareText = (share: number) => usedPercentText(share * 100);

export function FleetBusMapPane({ visible }: PaneProps) {
  const read = useQuery(busFeedQuery, { enabled: visible && !busFeedMissing(), freshMs: 0 });
  const refetch = useRefetch(busFeedQuery);
  usePollWhileVisible(() => { if (!busFeedMissing()) refetch(); }, 10_000, { enabled: visible && !busFeedMissing() });
  const map = useMemo(() => buildBusMap(read.data?.hops ?? []), [read.data]);
  if (busFeedMissing() || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Bus not in this build</p>;
  if (read.data === undefined || read.data === null) return <div className={styles.root} role="status">{read.status === 'error' || read.data === null ? 'Bus is unavailable.' : <><span>Reading bus…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const data = read.data;
  const agents = topTalkers(map.agents, MAX_AGENTS);
  return <section className={styles.root} aria-label="Bus map">
    <p className={styles.header}>{map.agents.length.toLocaleString()} agents · {map.totals.hops.toLocaleString()} hops · in {count(map.totals.inputTokens)} / out {count(map.totals.outputTokens)} tokens{data.hopsDropped > 0 && <> · {data.hopsDropped.toLocaleString()} hops dropped</>}</p>
    {data.sources.hops !== 'healthy' && <p className={styles.notice} role="status">Bus hop data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Bus could not refresh. Showing the last reading.</p>}
    {map.totals.hops === 0 ? <p className={styles.message}>No bus traffic in the recent window.</p> : <>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="Bus traffic by agent pair">
          <thead><tr>
            <th scope="col">Pair</th>
            <th scope="col" className={styles.num}>Hops</th>
            <th scope="col" className={styles.num}>Tokens in / out</th>
            <th scope="col">Share</th>
          </tr></thead>
          <tbody>{map.pairs.map(pair => <tr key={`${pair.from} ${pair.to}`}>
            <th scope="row" className={styles.pair}>
              <span className={styles.agentId} title={pair.from}>{truncateAgentId(pair.from)}</span>
              <span aria-hidden="true"> → </span>
              <span className={styles.agentId} title={pair.to}>{truncateAgentId(pair.to)}</span>
            </th>
            <td className={styles.num}>{pair.hops.toLocaleString()}</td>
            <td className={styles.num}>{count(pair.inputTokens)} / {count(pair.outputTokens)}</td>
            <td>
              <div className={styles.share}>
                <div className={styles.shareTrack}>
                  <div className={styles.shareFill} style={{ width: `${pair.share * 100}%` }} aria-label={`${shareText(pair.share)} of hops`} />
                </div>
                <span className={styles.shareText}>{shareText(pair.share)}</span>
              </div>
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>Agents</h3>
        <ol className={styles.agents} aria-label="Agents">
          {agents.map(agent => <li key={agent.id} className={styles.agentRow}>
            <span className={styles.agentId} title={agent.id}>{truncateAgentId(agent.id)}</span>
            <span className={styles.agentCounts}>{agent.sent.toLocaleString()} sent · {agent.received.toLocaleString()} received</span>
          </li>)}
          {map.agents.length > agents.length && <li className={styles.agentCounts}>+ {map.agents.length - agents.length} more</li>}
        </ol>
      </div>
    </>}
  </section>;
}
