/**
 * One pool on the Pools board: who it is, the plain-words line, a bar (used so far, what the current burn adds by
 * reset, what is left unused, and how far the window has run), its window so far when the board passes the stored readings, its labelled
 * readings and any per-model windows (the same bar: used so far and, for a weekly window, how far it has run).
 * Draws only what pools.v1 and the stored readings hold for the row.
 */
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { PoolUsageSeries } from '../../../../core/fleet/usage-history.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { PoolWindow, type WindowRead } from './PoolWindow.js';
import { WindowBar } from '../../../components/primitives/WindowBar.js';
import { KIND_WORD, poolBar, poolFacts, poolGroup, scopeDetail, scopeName, scopePace, scopeWords, tightestScope } from './pools-board-model.js';
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
  const facts = poolFacts(row, view, localTime);
  // Focusable from code only: the Runway line above the cards puts the keyboard here when a pool's name is chosen.
  return <li className={styles.row} data-pool={row.id} tabIndex={-1} data-risk={row.wasteRisk} data-group={poolGroup(row)} aria-label={`${row.id} pool`}>
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
    {row.scopes.length > 0 ? <PoolScopes row={row} /> : null}
  </li>;
}

/**
 * The pool's per-model windows, each on the card's own kind of bar: the share used, and the time mark where the
 * window's length is stated. Not tinted by the pool's risk, which is about the whole pool; a model nearer its
 * limit than the pool is said in words above the rows.
 */
function PoolScopes({ row }: { row: PoolRow }) {
  const tightest = tightestScope(row);
  return <div className={styles.scopes}>
    <p className={styles.scopesHead}><span>Windows by model</span>{tightest ? <span data-scope-tightest>{tightest}</span> : null}</p>
    <ul className={styles.scopeList} aria-label={`${row.id} windows by model`}>{row.scopes.map(scope => {
      const name = scopeName(scope.id);
      const pace = scopePace(scope);
      return <li key={scope.id} data-scope={scope.id} data-pace={pace === null || pace.lead === null ? undefined : pace.lead < 0 ? 'behind' : pace.lead > 0 ? 'ahead' : 'level'}>
        <span className={styles.scopeName}>{name}</span>
        <WindowBar label={`${row.id} ${name} used`} valueText={scopeWords(scope)} valueNow={scope.usedPct} used={scope.usedPct} elapsed={pace?.elapsedPct ?? null} />
        {scope.usedPct === null ? <span className={styles.scopeFigure} data-unknown>unknown</span>
          : <span className={styles.scopeFigure}>{scope.usedPct}%<span className={styles.scopeUnit}>used</span></span>}
        <span className={styles.scopeLine}>{scopeDetail(scope, localTime).join(' · ')}</span>
      </li>;
    })}</ul>
  </div>;
}
