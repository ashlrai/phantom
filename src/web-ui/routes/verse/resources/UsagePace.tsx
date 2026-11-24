/**
 * routes/verse/resources/UsagePace.tsx: which pool takes the next job, in the Resources drawer. The scheduler's
 * pace snapshot from GET /api/verse/usage-resources (the shares are what `phm fleet pools --json` prints) drawn
 * as a headline, one strip for how new ordinary work is split, and a row per pool in the scheduler's rank
 * order: provider mark and name, the verdict, the pool's share of new work, the shared WindowBar (used so far,
 * more by the reset at this burn, left unused) and the facts behind it. A pool with no reading keeps its row
 * with a hatched bar and the reason; a report older than two minutes is not read as current.
 */
import { seriesColor } from '../../../components/charts/colors.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useNow } from '../autonomy/use-ticker.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { usageResourcesQuery } from '../usage/usage-queries.js';
import { agoWords, paceView, type PaceRowView } from './usage-pace-model.js';
import styles from './usage-pace.module.css';

const BADGE_TONE: Readonly<Record<PaceRowView['state'], Tone>> = { wasting: 'info', on_pace: 'success', starving: 'warning', unknown: 'unknown' };

export function UsagePace() {
  const read = useQuery(usageResourcesQuery, { freshMs: 30_000 });
  const refetch = useRefetch(usageResourcesQuery);
  usePollWhileVisible(refetch, 30_000);
  const clock = useNow(1_000);
  const now = Math.max(clock, Date.now());
  const loading = read.data === undefined && read.error === undefined;
  // The report carries its own time, so the last good read stays up through a failed refresh until it turns stale.
  const view = paceView(read.data?.available ? read.data.raw : null, now);
  const note = read.data === undefined && read.error !== undefined ? 'The scheduler report could not be read.'
    : read.data?.available === false ? read.data.reason ?? view.note : view.note;
  const next = view.split[0]?.pool ?? null;
  return <section aria-label="Usage pace" className={styles.section} data-pace={view.state}>
    <div className={styles.top}>
      <h3>Usage pace</h3>
      {view.asOf !== null ? <span className={styles.asOf}>scheduler reported <time dateTime={view.asOf} title={view.asOf}>{agoWords(now - Date.parse(view.asOf))}</time></span> : null}
    </div>
    {loading ? <p className={styles.note} aria-busy="true">Reading the scheduler report…</p> : <>
      <p className={styles.headline} data-headline>{view.headline}</p>
      {note !== null ? <p className={styles.note} data-pace-note>{note}</p> : null}
      {view.split.length > 0 ? <div className={styles.split} role="img" data-split
        aria-label={`New work split: ${view.split.map(part => `${part.name} ${part.pct}%`).join(', ')}`}>
        {view.split.map(part => <i key={part.pool} data-pool={part.pool} style={{ width: `${part.pct}%`, background: seriesColor(part.slot) }} />)}
      </div> : null}
      {view.state === 'live' && view.rows.some(row => row.used !== null) ? <p className={styles.key} data-pace-key>
        {view.split.length > 0 ? <span>Strip: how new work is split</span> : null}
        <span><WindowBarSwatch part="used" />used so far</span>
        {view.projected ? <>
          <span><WindowBarSwatch part="more" />more by the reset at this burn</span>
          <span><WindowBarSwatch part="unused" />left unused at the reset</span>
        </> : null}
        <span>Same data: <code>phm fleet pools</code>.</span>
      </p> : null}
      <ul className={styles.rows} aria-label="Where to send work">{view.rows.map(row => <li key={row.pool} className={styles.row}
        data-pool={row.pool} data-state={row.state} data-next={row.pool === next || undefined}>
        <div className={styles.head}>
          <span className={styles.name}><ProviderBadge of={row.pool} iconOnly size={14} /><strong>{row.name}</strong></span>
          <StatusBadge status={row.state} tone={BADGE_TONE[row.state]}>{row.verdict}</StatusBadge>
          <span className={styles.figure} data-figure>
            {row.sharePct !== null && row.sharePct > 0 ? <i className={styles.dot} style={{ background: seriesColor(row.slot) }} aria-hidden="true" /> : null}
            {row.figure}
          </span>
        </div>
        <WindowBar label={`${row.name} used`} valueText={row.valueText} valueNow={row.used} used={row.used} more={row.more} unused={row.unused} ending={row.ending} />
        <p className={styles.facts} data-facts>{row.facts.join(' · ')}</p>
      </li>)}</ul>
    </>}
  </section>;
}
