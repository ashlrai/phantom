/**
 * routes/fleet-dashboard/QueueStationGraph.tsx — the live station graph
 * (RQ-QUEUE-5). One node per reported station in pipeline order, colored by
 * rho band, labelled with the queue length; the bottleneck station gets a
 * heavy outline and a callout. Data is GET /api/queue/stats — the same
 * estimateQueueStats payload `phm queue stats --json` prints — polled on a
 * fixed cadence (plus on tab refocus) since no SSE event covers it yet.
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { queueStatsQuery } from '../../data/queries.js';
import {
  RHO_AMBER,
  RHO_RED,
  rhoBand,
  selectBottleneck,
  type QueueStatsView,
} from '../../data/queue-stats/model.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import panel from './Panel.module.css';
import styles from './QueueStationGraph.module.css';

const NODE_W = 108;
const NODE_H = 58;
const GAP = 26;
const POLL_MS = 15_000;

export interface QueueStationGraphProps {
  /** Stats window in seconds (the route's `?window=`); default 1 hour. */
  windowSec?: number;
}

export function QueueStationGraph({ windowSec = 3600 }: QueueStationGraphProps) {
  const query = useMemo(() => queueStatsQuery(windowSec), [windowSec]);
  const { data, status, error, updatedAt } = useQuery(query);
  const refresh = useRefetch(query);

  useEffect(() => {
    let disposed = false;
    const poll = () => { if (!disposed && document.visibilityState !== 'hidden') refresh(); };
    const timer = window.setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [refresh]);

  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-queue">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Queue stations</span>
        <span className={styles.meta}>
          {status === 'refreshing' ? <RefreshIndicator /> : null}
          {updatedAt ? `updated ${formatRelative(updatedAt)}` : null}
        </span>
      </summary>
      <div className={panel.panelBody}>
        {status === 'loading' ? <SkeletonLine width="60%" /> : null}
        {status === 'error' ? (
          <p className={styles.notice} role="alert">
            Queue stats unavailable. {error?.message}
            {data ? ' Showing the last successful reading.' : ''}
          </p>
        ) : null}
        {data ? <Graph stats={data} /> : null}
      </div>
    </details>
  );
}

function Graph({ stats }: { stats: QueueStatsView }) {
  if (stats.stations.length === 0 && stats.pools.length === 0) {
    return (
      <p className={styles.empty}>
        No queue visits recorded in this window. Stations light up once work
        flows through the queue journal (<code>phm queue stats</code> reads the
        same data).
      </p>
    );
  }
  const bottleneck = selectBottleneck(stats.stations);
  const drifting = stats.stations.filter((s) => s.littleDrift === true);
  const width = stats.stations.length * (NODE_W + GAP);
  return (
    <>
      <p className={styles.summary}>
        Window {Math.round(stats.windowMs / 60000)}m · bottleneck:{' '}
        <strong data-testid="queue-bottleneck">{bottleneck ?? 'none'}</strong>
        {drifting.length > 0 ? (
          <span className={styles.driftNote} data-testid="little-drift">
            {' '}· Little’s law drift on {drifting.map((s) => s.label).join(', ')}
          </span>
        ) : null}
      </p>
      {stats.stations.length > 0 ? (
        <div className={styles.scroll}>
          <svg
            role="img"
            aria-label="Queue station graph"
            viewBox={`0 0 ${width} ${NODE_H + 34}`}
            width={width}
            className={styles.svg}
          >
            {stats.stations.map((station, i) => {
              const band = rhoBand(station);
              const x = i * (NODE_W + GAP) + GAP / 2;
              const isBottleneck = station.station === bottleneck;
              const rhoText = station.rho === null ? 'ρ —' : `ρ ${station.rho.toFixed(2)}`;
              return (
                <g
                  key={station.station}
                  data-testid={`station-${station.station}`}
                  data-band={band}
                  data-bottleneck={isBottleneck ? 'true' : 'false'}
                >
                  {i > 0 ? (
                    <line
                      x1={x - GAP}
                      y1={22 + NODE_H / 2}
                      x2={x}
                      y2={22 + NODE_H / 2}
                      className={styles.edge}
                    />
                  ) : null}
                  {isBottleneck ? (
                    <text x={x + NODE_W / 2} y={12} textAnchor="middle" className={styles.bottleneckTag}>
                      bottleneck
                    </text>
                  ) : null}
                  <rect
                    x={x}
                    y={22}
                    width={NODE_W}
                    height={NODE_H}
                    rx={8}
                    className={styles.node}
                    data-band={band}
                    strokeWidth={isBottleneck ? 4 : station.littleDrift === true ? 2 : 0}
                    strokeDasharray={station.littleDrift === true && !isBottleneck ? '5 3' : undefined}
                  />
                  <title>
                    {`${station.label}: rho ${station.rho === null ? 'n/a' : station.rho.toFixed(2)}, ` +
                      `queue ${station.currentQueueLength} now (${station.queueLength.toFixed(2)} avg), ` +
                      `in service ${Math.max(0, station.currentWip - station.currentQueueLength)}, ` +
                      `λ ${perHour(station.lambda)}/h, μ ${station.mu === null ? 'n/a' : `${perHour(station.mu)}/h`}, ` +
                      `wait ${station.wait === null ? 'n/a' : formatDuration(station.wait)}`}
                  </title>
                  <text x={x + NODE_W / 2} y={44} textAnchor="middle" className={styles.nodeTitle}>
                    {station.label}
                  </text>
                  <text x={x + NODE_W / 2} y={62} textAnchor="middle" className={styles.nodeMetric}>
                    {`${rhoText} · q ${station.currentQueueLength}`}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}
      <ul className={styles.legend}>
        <li><span className={styles.swatch} data-band="idle" />idle</li>
        <li><span className={styles.swatch} data-band="green" />ρ &lt; {RHO_AMBER}</li>
        <li><span className={styles.swatch} data-band="amber" />{RHO_AMBER}–{RHO_RED}</li>
        <li><span className={styles.swatch} data-band="red" />ρ ≥ {RHO_RED}</li>
        <li><span className={styles.swatch} data-band="unknown" />no service data</li>
      </ul>
      {stats.pools.length > 0 ? (
        <ul className={styles.pools} data-testid="queue-pools">
          {stats.pools.map((pool) => (
            <li key={pool.pool}>
              <code>{pool.pool}</code>{' '}
              {pool.rho === null ? 'ρ —' : `ρ ${pool.rho.toFixed(2)}`} · q {pool.currentQueueLength}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function perHour(perSecond: number): string {
  return (perSecond * 3600).toFixed(1);
}

function formatDuration(seconds: number): string {
  return seconds >= 120 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`;
}

function formatRelative(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
