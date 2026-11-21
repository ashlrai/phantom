/** The `phm metrics loop` stage times as one card: the biggest wait in words, then p50 and p90 per stage with unknowns counted. */
import { LOOP_STAGES_SCHEMA, minutesText, stageWords, type LoopStagesReport } from '../../../../core/metrics/loop-stages.js';
import styles from './fleet-metrics.module.css';

const cell = (minutes: number | null): string => minutes === null ? 'unknown' : minutesText(minutes);

export type LoopWindow = '24h' | '7d';
const WINDOW_WORDS: Record<LoopWindow, string> = { '24h': 'the last 24 hours', '7d': 'the last 7 days' };
/** Each stage's median as a share of the longest median, so the bars compare stages and claim no total. Null where a stage has no median. */
export function stageBars(stages: ReadonlyArray<{ p50_minutes: number | null }>): Array<number | null> {
  const longest = Math.max(0, ...stages.map(row => row.p50_minutes ?? 0));
  return stages.map(row => row.p50_minutes === null ? null : longest > 0 ? Math.round((row.p50_minutes / longest) * 100) : 0);
}

/** `report` is undefined while loading or when the server predates the report: the card then reads unknown. `range` is the one control: 24h or 7d. */
export function LoopStagesCard({ report, range = '24h', onWindow }: { report: LoopStagesReport | undefined; range?: LoopWindow; onWindow?: (next: LoopWindow) => void }) {
  const known = report?.schema === LOOP_STAGES_SCHEMA && Array.isArray(report.stages) ? report : undefined;
  const bars = stageBars(known?.stages ?? []);
  return <section className={styles.card} aria-label="Loop stages">
    <div className={styles.cardHead}>
      <h3 className={styles.heading}>Where the loop waits</h3>
      {onWindow ? <div role="group" aria-label="Window" className={styles.window}>{(['24h', '7d'] as const).map(w =>
        <button key={w} type="button" aria-pressed={range === w} onClick={() => onWindow(w)}>{w === '24h' ? '24 hours' : '7 days'}</button>)}</div> : null}
    </div>
    {!known ? <p className={styles.note}>Loop stages: unknown{onWindow && range === '7d' ? ' (reading the 7 day window)' : ''}</p> : <>
      <p className={styles.note}>{known.headline}. {known.jobs} finished job{known.jobs === 1 ? '' : 's'} in {WINDOW_WORDS[range]}.</p>
      {known.jobs_truncated === true ? <p className={styles.note}>jobs.jsonl tail was cut at the read cap: stage times cover only the newest bytes.</p> : null}
      {known.releases === 'unavailable' ? <p className={styles.note}>Merged to released: unknown. {known.releases_reason ?? 'Releases could not be read.'}</p> : null}
      <div className={styles.scroll}>
        <table className={styles.table}><caption>Minutes per stage. Same report as phm metrics loop.</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">p50</th><th scope="col">p90</th><th scope="col">Unknown</th></tr></thead>
          <tbody>{known.stages.map((row, i) => <tr key={row.stage} data-slowest={known.slowest?.stage === row.stage ? 'true' : undefined}>
            <th scope="row">{stageWords(row.stage)}
              {/* The median against the slowest stage's; hatched where no job gave this stage a time. */}
              <span className={styles.bar} data-stage="" data-unknown={bars[i] === null ? '' : undefined} aria-hidden="true">
                {bars[i] === null ? null : <span className={styles.used} style={{ width: `${bars[i]}%` }} />}</span></th><td>{cell(row.p50_minutes)}</td><td>{cell(row.p90_minutes)}</td>
            <td>{row.unknown}{row.pending ? ` (+${row.pending} waiting)` : ''}</td></tr>)}</tbody></table>
      </div>
    </>}
  </section>;
}
