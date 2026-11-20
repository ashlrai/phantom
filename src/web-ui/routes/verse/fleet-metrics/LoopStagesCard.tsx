/** The `phm metrics loop` stage times as one card: the biggest wait in words, then p50 and p90 per stage with unknowns counted. */
import { LOOP_STAGES_SCHEMA, minutesText, stageWords, type LoopStagesReport } from '../../../../core/metrics/loop-stages.js';
import styles from './fleet-metrics.module.css';

const cell = (minutes: number | null): string => minutes === null ? 'unknown' : minutesText(minutes);

/** `report` is undefined while loading or when the server predates the report: the card then reads unknown. */
export function LoopStagesCard({ report }: { report: LoopStagesReport | undefined }) {
  const known = report?.schema === LOOP_STAGES_SCHEMA && Array.isArray(report.stages) ? report : undefined;
  return <section className={styles.root} aria-label="Loop stages">
    <h3 className={styles.heading}>Where the loop waits</h3>
    {!known ? <p className={styles.note}>Loop stages: unknown</p> : <>
      <p className={styles.note}>{known.headline}. {known.jobs} finished job{known.jobs === 1 ? '' : 's'} in the last 24 hours.</p>
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
