/** The `phm metrics` report: four big numbers, the lane table and one spend-down bar per pool. */
import type { ReactNode } from 'react';
import type { MetricsLane, MetricsPool, MetricsReport } from '../../../../core/fleet/metrics-glance.js';
import { StatTile } from '../../../components/charts/StatTile.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { laneOutcome } from './metrics-board-model.js';
import styles from './fleet-metrics.module.css';

const shown = (value: number | null | undefined): string => value == null ? 'unknown' : String(value);
const percent = (rate: number | null | undefined): string => rate == null ? 'unknown' : `${Math.round(rate * 100)}%`;
const duration = (seconds: number | null | undefined): string => seconds == null ? 'unknown' : seconds < 60 ? `${seconds}s`
  : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;

/** How the lane's finished jobs ended, drawn under its merge rate. The cells beside it carry the numbers, so the bar is not announced. */
function OutcomeBar({ lane }: { lane: MetricsLane }) {
  const outcome = laneOutcome(lane);
  return <span className={styles.outcome} aria-hidden="true" data-unknown={outcome ? undefined : ''}>
    {outcome ? <><span className={styles.outcomeMerged} style={{ width: `${outcome.mergedPct}%` }} /><span className={styles.outcomeEmpty} style={{ width: `${outcome.emptyPct}%` }} /></> : null}
  </span>;
}

function PoolBar({ pool }: { pool: MetricsPool }) {
  const known = pool.at_risk !== null;
  const used = Math.min(100, pool.used_pct ?? 0);
  // The lighter segment is what the pool is on pace to use by reset.
  const projected = pool.projected_unused_pct === null ? used : Math.max(used, 100 - pool.projected_unused_pct);
  const pct = (value: number | null): string => value === null ? 'unknown' : `${value}%`;
  const words = !known ? `unknown: ${pool.reason ?? 'reading missing'}` : [`${pct(pool.used_pct)} used`, `${shown(pool.hours_to_reset)} h to reset`,
    `${pct(pool.projected_unused_pct)} projected unused`, pool.waste_risk ? `waste risk ${pool.waste_risk}` : pool.at_risk ? 'at risk' : 'on pace'].join(' · ');
  return <li className={styles.pool} data-risk={pool.at_risk ? 'true' : undefined}>
    <span className={styles.poolName}><BrandMark brand={pool.pool} size={14} /><span>{pool.pool}</span></span>
    {known && pool.used_pct !== null
      ? <span className={styles.bar} role="meter" aria-label={`${pool.pool} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-valuetext={words}>
        <span className={styles.projected} style={{ width: `${projected}%` }} /><span className={styles.used} style={{ width: `${used}%` }} /></span>
      // No reading: hatched, so an unread pool never looks like an unused one.
      : <span className={styles.bar} data-unknown="" aria-hidden="true" />}
    <span className={styles.poolFacts}>{words}</span>
  </li>;
}

/**
 * `report` is undefined while loading or when the server predates the report: every value then reads unknown.
 * `trend` is the measured merges in each of the last 24 hours, drawn under the first number; `below` sits between the numbers and the lanes.
 */
export function MetricsGlance({ report, capacity = {}, trend, below }: {
  report: MetricsReport | undefined; capacity?: Record<string, string>; trend?: (number | null)[]; below?: ReactNode;
}) {
  const pace = report?.merged_per_hour;
  const emptyLanes = report?.lanes?.filter(lane => lane.empty_high).map(lane => lane.name) ?? [];
  const risky = report?.pools.filter(pool => pool.at_risk).map(pool => pool.pool) ?? [];
  const unread = report?.pools.filter(pool => pool.at_risk === null).length ?? 0;
  const period = !report ? '' : report.hours === 1 ? 'last hour' : `last ${report.hours} hours`;
  return <div className={styles.root}>
    <div className={styles.tiles}>
      <StatTile label="Merged per hour" value={shown(pace?.window)} caption={`1 h ${shown(pace?.last_1h)} · 6 h ${shown(pace?.last_6h)} · 24 h ${shown(pace?.last_24h)}`}
        trend={trend} trendLabel="PRs merged in each of the last 24 hours" describeTrend={String} />
      <StatTile label="Median merge time" value={duration(report?.median_publish_to_merge_s)} caption={`publish to merge${period && `, ${period}`}`} />
      <StatTile label="Empty rate" value={percent(report?.empty_rate)} caption={!report?.lanes ? 'lanes unknown' : emptyLanes.length ? `over half empty: ${emptyLanes.join(', ')}` : 'no lane over half empty'} />
      <StatTile label="Pools at risk" value={shown(report?.pools_at_risk)} caption={[risky.join(', '), unread ? `${unread} unknown` : ''].filter(Boolean).join(' · ') || 'none would go unused'} />
    </div>
    {report && report.sources.jobs !== 'ok' ? <p className={styles.note} data-warn="">Cannot read the job metrics file, so merge pace, merge time and empty rate are unknown.</p> : null}
    {report && report.sources.status !== 'ok' ? <p className={styles.note} data-warn="">The dispatcher status is {report.sources.status}, so lanes, tiers and spend-down are unknown.</p> : null}
    {below}
    <div className={styles.card}>
      <h3 className={styles.heading}>Lanes</h3>
      {!report?.lanes ? <p className={styles.note}>Lanes: unknown</p> : <>
        <div className={styles.scroll}>
          <table className={styles.table}><caption>Jobs launched in the last 24 hours</caption>
            <thead><tr><th scope="col">Lane</th><th scope="col">Jobs</th><th scope="col">Merged</th><th scope="col">Empty</th><th scope="col">Merge rate</th><th scope="col">Running / target</th></tr></thead>
            <tbody>{report.lanes.map(lane => <tr key={lane.name} data-empty-high={lane.empty_high ? 'true' : undefined}>
              <th scope="row"><span className={styles.named}><BrandMark brand={lane.name} size={14} /><span>{lane.name}</span></span></th><td>{shown(lane.jobs)}</td><td>{shown(lane.merged)}</td>
              <td>{percent(lane.empty_rate)}{lane.empty_high ? ' (over half)' : ''}</td><td>{percent(lane.merge_rate)}<OutcomeBar lane={lane} /></td><td>{capacity[lane.name] ?? 'unknown'}</td></tr>)}</tbody></table>
        </div>
        <p className={styles.legend}><span className={styles.swatch} data-kind="merged" aria-hidden="true" />merged <span className={styles.swatch} data-kind="empty" aria-hidden="true" />changed nothing
          {' '}<span className={styles.swatch} aria-hidden="true" />finished some other way <span className={styles.swatch} data-kind="unknown" aria-hidden="true" />not measured. Shares of each lane's finished jobs.</p>
      </>}
      {report?.tiers?.length ? <p className={styles.note}>Merge rate by tier: {report.tiers.map(tier => `${tier.name} ${percent(tier.merge_rate)}`).join(' · ')}</p> : null}
    </div>
    <div className={styles.card}>
      <h3 className={styles.heading}>Spend-down</h3>
      {!report ? <p className={styles.note}>Spend-down: unknown</p>
        : !report.pools.length ? <p className={styles.note}>The report lists no pool.</p>
        : <ul className={styles.pools} aria-label="Spend-down by pool">{report.pools.map(pool => <PoolBar key={pool.pool} pool={pool} />)}</ul>}
    </div>
  </div>;
}
