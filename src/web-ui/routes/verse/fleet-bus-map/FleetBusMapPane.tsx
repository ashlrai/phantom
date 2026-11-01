import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { IconCopy } from '../../../components/primitives/icons.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { busFeedMissing, busFeedQuery } from '../fleet/bus-feed-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { agentBusMapQuery } from './agent-bus-map-queries.js';
import { buildBusMap, lastHopText, topTalkers, truncateAgentId } from './bus-map-model.js';
import { buildDurableMap, durableTotalsLine } from './durable-map-model.js';
import styles from './fleet-bus-map.module.css';

const count = (value: number | null) => value === null ? '—' : value.toLocaleString();
const MAX_AGENTS = 10;
const shareText = (share: number) => usedPercentText(share * 100);

/** Icon-only copy of a full agent id — the row only ever shows it truncated. */
function CopyAgentId({ id }: { id: string }) {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice !== 'Copied') return;
    const timer = setTimeout(() => setNotice(''), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(id); setNotice('Copied'); }
    catch { setNotice('Copy failed'); }
  };
  return <>
    <Button variant="ghost" size="sm" iconOnly icon={<IconCopy size={14} />}
      aria-label={`Copy agent id ${id}`} title={`Copy agent id ${id}`} onClick={() => void copy()} />
    {notice !== '' && <span role="status">{notice}</span>}
  </>;
}

function DispatchBusMap({ visible }: PaneProps) {
  const read = useQuery(busFeedQuery, { enabled: visible && !busFeedMissing(), freshMs: 0 });
  const refetch = useRefetch(busFeedQuery);
  usePollWhileVisible(() => { if (!busFeedMissing()) refetch(); }, 10_000, { enabled: visible && !busFeedMissing() });
  const map = useMemo(() => buildBusMap(read.data?.hops ?? []), [read.data]);
  if (busFeedMissing() || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Bus not in this build</p>;
  if (read.data === undefined || read.data === null) return <div className={styles.root} role="status">{read.status === 'error' || read.data === null ? 'Bus is unavailable.' : <><span>Reading bus…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const data = read.data;
  const agents = topTalkers(map.agents, MAX_AGENTS);
  const freshness = lastHopText(data.lastHopAt, Date.now());
  return <section className={styles.root} aria-label="Bus map">
    <p className={styles.header}>{map.agents.length.toLocaleString()} agents · {map.totals.hops.toLocaleString()} hops · in {count(map.totals.inputTokens)} / out {count(map.totals.outputTokens)} tokens{data.hopsDropped > 0 && <> · {data.hopsDropped.toLocaleString()} hops dropped</>}<span> · {freshness}</span></p>
    {data.sources.hops !== 'healthy' && <p className={styles.notice} role="status">Bus hop data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Bus could not refresh. Showing the last reading.</p>}
    {map.totals.hops === 0 ? <p className={styles.message}>No bus traffic in the recent window.<span> · {freshness}</span></p> : <>
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
            <CopyAgentId id={agent.id} />
          </li>)}
          {map.agents.length > agents.length && <li className={styles.agentCounts}>+ {map.agents.length - agents.length} more</li>}
        </ol>
      </div>
    </>}
  </section>;
}

function DurableBusMap({ visible }: PaneProps) {
  const read = useQuery(agentBusMapQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(agentBusMapQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  const map = useMemo(() => read.data ? buildDurableMap(read.data) : null, [read.data]);
  const totals = map && durableTotalsLine(map, Date.now());
  return <section className={styles.root} aria-label="Durable bus">
    <h3 className={styles.sectionTitle}>Durable bus</h3>
    {read.data === null ? <p className={styles.message}>Durable bus unavailable (dispatch off or store missing).</p>
      : !map ? <p className={styles.message}>{read.status === 'error' ? 'Durable bus could not be read.' : 'Reading durable bus…'}</p>
        : <>
          {read.status === 'error' && <p className={styles.notice}>Durable bus could not refresh. Showing the last reading.</p>}
          {totals ? <p className={styles.header}>{totals}</p> : <p className={styles.message}>No durable bus traffic in this page.</p>}
          {read.data?.messages.length === 100 && <p className={styles.message}>Showing the first 100 live envelopes.</p>}
          {map.pairs.length > 0 && <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="Durable bus traffic by agent pair">
              <thead><tr><th scope="col">Pair</th><th scope="col" className={styles.num}>Envelopes</th><th scope="col">Share</th></tr></thead>
              <tbody>{map.pairs.map(pair => <tr key={JSON.stringify([pair.from, pair.to])}>
                <th scope="row" className={styles.pair}>
                  <span className={styles.agentId} title={pair.from}>{truncateAgentId(pair.from)}</span>
                  <span aria-hidden="true"> → </span>
                  <span className={styles.agentId} title={pair.to}>{truncateAgentId(pair.to)}</span>
                </th>
                <td className={styles.num}>{pair.hops.toLocaleString()}</td>
                <td><div className={styles.share}>
                  <div className={styles.shareTrack}><div className={styles.shareFill} style={{ width: `${pair.share * 100}%` }} aria-label={`${shareText(pair.share)} of envelopes`} /></div>
                  <span className={styles.shareText}>{shareText(pair.share)}</span>
                </div></td>
              </tr>)}</tbody>
            </table>
          </div>}
        </>}
  </section>;
}

export function FleetBusMapPane(props: PaneProps) {
  return <><DispatchBusMap {...props} /><DurableBusMap {...props} /></>;
}
