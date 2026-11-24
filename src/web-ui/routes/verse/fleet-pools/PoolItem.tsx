/**
 * One pool on the Pools board: who it is, the plain-words line, a bar (used so far, what the current burn adds by
 * reset, what is left unused, and how far the window has run), its window so far when the board passes the stored readings, its labelled
 * readings and any per-model windows. Draws only what pools.v1 and the stored readings hold for the row.
 */
import { reservePace } from '../../../../core/usage/reserve-pace.js';
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { PoolWindow, type WindowRead } from './PoolWindow.js';
import { WindowBar } from '../../../components/primitives/WindowBar.js';
import { KIND_WORD, poolBar, poolFacts, poolGroup, scopeLine, scopeName } from './pools-board-model.js';
import styles from './fleet-pools.module.css';

export const localTime = (iso: string | null): string => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
};

/** The same bar Home draws for a pool, with the window's elapsed time marked on it. No reading is hatched, never an empty (0% used) bar. */
function PoolBar({ row }: { row: PoolRow }) {
  const bar = poolBar(row);
  return <WindowBar label={`${row.id} used`} valueText={bar.words} valueNow={row.usedPct} used={row.usedPct} more={bar.more} unused={bar.unused}
    elapsed={row.elapsedPct} ending={bar.ending} />;
}

/** The stored readings of every pool's window, as the board last read them; `pools` is empty until the read answers. */
export interface PoolWindows { read: WindowRead; now: number; pools: readonly PoolUsageSeries[] }

export function PoolItem({ row, view, windows }: { row: PoolRow; view: Pick<PoolsViewV1, 'generatedAt'>; windows?: PoolWindows }) {
  const pace = reservePace(row);
  const facts = poolFacts(row, view, localTime);
  // Focusable from code only: the Runway line above the cards puts the keyboard here when a pool's name is chosen.
  return <li className={styles.row} data-board-card data-pool={row.id} tabIndex={-1} data-risk={row.wasteRisk} data-group={poolGroup(row)} aria-label={`${row.id} pool`}>
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
    {row.kind === 'subscription' ? <p className={styles.pace} data-over={pace.verdict === 'over' || undefined}>{pace.line}</p> : null}
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
