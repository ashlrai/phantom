/**
 * routes/verse/fleet-pools/PoolRunway.tsx — "Runway ahead" on the Pools board:
 * every plan pool on one line of time that starts at the reading, drawn to its
 * reset, with the stretch it would sit empty hatched when the pool runs out
 * first. The cards below say each pool on its own; this says which runs out
 * when, and how long each then waits.
 *
 * The line and its ticks are decoration (aria-hidden): each row carries the
 * same facts as text. State never rests on colour: a dry stretch is hatched
 * and worded, an unprojected pool is dashed and worded. A pool's name is a
 * button that brings its card into view and puts the keyboard on it.
 */
import type { CSSProperties } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import type { ResetTick } from '../fleet-usage/reset-timeline-model.js';
import type { PoolRunway as Runway, RunwayRow } from './pool-runway-model.js';
import styles from './pool-runway.module.css';

const at = (leftPct: number): CSSProperties => ({ left: `${leftPct}%` });

function Ticks({ ticks, labelled = false }: { ticks: readonly ResetTick[]; labelled?: boolean }) {
  return <>{ticks.map(tick => <span key={tick.leftPct} className={labelled ? styles.tickLabel : styles.tick} style={at(tick.leftPct)}>{labelled ? tick.label : null}</span>)}</>;
}

function Track({ row, ticks }: { row: RunwayRow; ticks: readonly ResetTick[] }) {
  const end = row.emptyPct ?? row.resetPct;
  return <span className={styles.track} aria-hidden="true">
    <Ticks ticks={ticks} />
    <span className={styles.run} style={{ width: `${end}%` }} />
    {row.emptyPct === null ? null : <span className={styles.dry} data-dry style={{ left: `${row.emptyPct}%`, width: `${row.resetPct - row.emptyPct}%` }} />}
    <span className={styles.dot} style={at(row.resetPct)} />
  </span>;
}

export function PoolRunway({ runway, onShow }: { runway: Runway; onShow: (pool: string) => void }) {
  return <section className={styles.root} aria-labelledby="fleet-pools-runway-title">
    <h3 id="fleet-pools-runway-title" className={styles.title}>Runway ahead</h3>
    <p className={styles.summary}>{runway.summary}</p>
    <div className={styles.row} aria-hidden="true">
      <span />
      <span className={styles.scale}>
        <span className={styles.tickLabel} data-edge="start" style={at(0)}>now</span>
        <Ticks ticks={runway.ticks} labelled />
      </span>
    </div>
    <ol className={styles.rows} aria-label="Runway ahead, soonest reset first">
      {runway.rows.map(row => <li key={row.key} className={styles.row} data-state={row.state} data-flagged={row.flagged || undefined} data-scope={row.scope || undefined}>
        {row.scope ? <span className={styles.name}>{row.name}</span>
          : <button type="button" className={styles.name} aria-label={`${row.name}: show its card`} onClick={() => onShow(row.pool)}>
            <ProviderBadge of={row.pool} iconOnly size={12} />{row.name}
          </button>}
        <Track row={row} ticks={runway.ticks} />
        <time className={styles.when} dateTime={row.resetAt}>{row.when}</time>
        <span className={styles.words}>{row.words}</span>
      </li>)}
    </ol>
    {runway.off.length > 0 ? <p className={styles.off}>Not on the line: {runway.off.map(entry => `${entry.name} (${entry.why})`).join(', ')}.</p> : null}
    <p className={styles.off}>Line: from the reading to the reset. Hatched: the wait with nothing left, at this burn; amber where the pool's own line says slow down. Dashed: no usage or burn reading, so nothing is projected. Same data: <code>phm pools</code>.</p>
  </section>;
}
