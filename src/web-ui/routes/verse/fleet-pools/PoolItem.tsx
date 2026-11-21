/**
 * One pool on the Pools board: who it is, the plain-words line, a bar (used so far, where the current burn ends by
 * reset, and how far the window has run), its window so far when the board passes the stored readings, its labelled
 * readings and any per-model windows. Draws only what pools.v1 and the stored readings hold for the row.
 */
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { PoolWindow, type WindowRead } from './PoolWindow.js';
import { KIND_WORD, poolFacts, poolGroup, projectedEndPct, scopeLine, scopeName } from './pools-board-model.js';
import styles from './fleet-pools.module.css';

export const localTime = (iso: string | null): string => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
};

function PoolBar({ row }: { row: PoolRow }) {
  // No reading: hatched, so an unknown bar never looks like an empty (0% used) one.
  if (row.usedPct === null) return <div className={styles.track} data-unknown role="img" aria-label={`${row.id} usage unknown`} />;
  const end = projectedEndPct(row);
  const label = `${row.id}: ${row.usedPct}% used`
    + (row.elapsedPct === null ? '' : `, ${row.elapsedPct}% of the window elapsed`)
    + (end === null ? '' : `, ${end}% by reset at this burn`);
  return <div className={styles.track} role="img" aria-label={label}>
    {end !== null && end > row.usedPct ? <span className={styles.projected} style={{ width: `${end}%` }} /> : null}
    <span className={styles.fill} style={{ width: `${row.usedPct}%` }} />
    {row.elapsedPct === null ? null : <span className={styles.marker} style={{ left: `${row.elapsedPct}%` }} />}
  </div>;
}

/** The stored readings of every pool's window, as the board last read them; `pools` is empty until the read answers. */
export interface PoolWindows { read: WindowRead; now: number; pools: readonly PoolUsageSeries[] }

export function PoolItem({ row, view, windows }: { row: PoolRow; view: Pick<PoolsViewV1, 'generatedAt'>; windows?: PoolWindows }) {
  const facts = poolFacts(row, view, localTime);
  return <li className={styles.row} data-risk={row.wasteRisk} data-group={poolGroup(row)} aria-label={`${row.id} pool`}>
    <div className={styles.head}>
      <span className={styles.name}>
        <ProviderBadge of={row.id} iconOnly size={14} />
        <strong>{row.id}</strong>
        <span className={styles.tag}>{KIND_WORD[row.kind]}</span>
        {row.held === true ? <span className={styles.tag} data-held>held</span> : null}
      </span>
      {/* The words carry the state; the mark before them only repeats it. */}
      <span className={styles.summary}>{row.summary}</span>
    </div>
    {/* Only a plan window is a share of something: a credit balance or an unmetered lane gets no bar. */}
    {row.kind === 'subscription' ? <PoolBar row={row} /> : null}
    {row.kind === 'subscription' && windows ? <PoolWindow row={row} read={windows.read} now={windows.now} series={windows.pools.find(series => series.pool === row.id)} /> : null}
    {facts.length > 0 ? <dl className={styles.facts}>{facts.map(fact => <div key={fact.label} className={styles.fact}>
      <dt>{fact.label}</dt>
      <dd data-unknown={fact.value === null || undefined}>{fact.value ?? 'unknown'}</dd>
      {fact.note ? <dd className={styles.note}>{fact.note}</dd> : null}
    </div>)}</dl> : null}
    {row.scopes.length > 0 ? <ul className={styles.scopes} aria-label={`${row.id} windows by model`}>{row.scopes.map(scope => {
      const name = scopeName(scope.id);
      return <li key={scope.id}>
        <span>{name}</span>
        <div className={styles.track} data-unknown={scope.usedPct === null || undefined} role="img" aria-label={`${name}: ${scope.usedPct === null ? 'usage unknown' : `${scope.usedPct}% used`}`}>
          {scope.usedPct === null ? null : <span className={styles.scopeFill} style={{ width: `${scope.usedPct}%` }} />}
        </div>
        <span className={styles.scopeLine}>{scopeLine(scope)}</span>
      </li>;
    })}</ul> : null}
  </li>;
}
