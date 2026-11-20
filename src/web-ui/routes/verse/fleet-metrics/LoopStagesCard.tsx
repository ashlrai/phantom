/** The `phm metrics loop` stage times as one card: the biggest wait in words, then p50 and p90 per stage with unknowns counted. */
import { LOOP_STAGES_SCHEMA, minutesText, stageWords, type LoopStagesReport } from '../../../../core/metrics/loop-stages.js';
import styles from './fleet-metrics.module.css';

const cell = (minutes: number | null): string => minutes === null ? 'unknown' : minutesText(minutes);

export type LoopWindow = '24h' | '7d';
const WINDOW_WORDS: Record<LoopWindow, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days' };

/** `report` is undefined while loading or when the server predates the report: the card then reads unknown. `range` is the one control: 24h or 7d. */
export function LoopStagesCard({ report, range = '24h', onWindow }: { report: LoopStagesReport | undefined; range?: LoopWindow; onWindow?: (next: LoopWindow) => void }) {
  const known = report?.schema === LOOP_STAGES_SCHEMA && Array.isArray(report.stages) ? report : undefined;
  return <section className={styles.root} aria-label="Loop stages">
    <h3 className={styles.heading}>Where the loop waits</h3>
    {onWindow ? <div role="group" aria-label="Window">{(['24h', '7d'] as const).map(w =>
      <button key={w} type="button" aria-pressed={range === w} onClick={() => onWindow(w)}>{w === '24h' ? '24 hours' : '7 days'}</button>)}</div> : null}
    {!known ? <p className={styles.note}>Loop stages: unknown{onWindow && range === '7d' ? ' (reading the 7 day window)' : ''}</p> : <>
      <p className={styles.note}>{known.headline}. {known.jobs} finished job{known.jobs === 1 ? '' : 's'} in {WINDOW_WORDS[range]}.</p>
      {known.releases === 'unavailable' ? <p className={styles.note}>Merged to released: unknown. {known.releases_reason ?? 'Releases could not be read.'}</p> : null}
      <div className={styles.scroll}>
        <table className={styles.table}><caption>Minutes per stage. Same report as phm metrics loop.</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">p50</th><th scope="col">p90</th><th scope="col">Unknown</th></tr></thead>
          <tbody>{known.stages.map(row => <tr key={row.stage} data-slowest={known.slowest?.stage === row.stage ? 'true' : undefined}>
            <th scope="row">{stageWords(row.stage)}</th><td>{cell(row.p50_minutes)}</td><td>{cell(row.p90_minutes)}</td>
            <td>{row.unknown}{row.pending ? ` (+${row.pending} waiting)` : ''}</td></tr>)}</tbody></table>
      </div>
    </>}
  </section>;
}
