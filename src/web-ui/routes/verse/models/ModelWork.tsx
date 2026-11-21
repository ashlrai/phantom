/**
 * The work line at the foot of a Models board card: the jobs launched on that model across the window as one row of
 * bars (drawn against the busiest bar on the whole board, so cards compare), a mark under each bar that had a PR
 * merged, and the counts in words. It draws only what `phm throughput --by model` reports for that model; a model
 * with nothing recorded is an empty line, and a report that could not be read is hatched and says unknown.
 */
import { barHeight, type ModelWork, type WorkBoard } from './model-work-model.js';
import styles from './model-work.module.css';

export function ModelWorkLine({ work, board }: { work: ModelWork; board: Pick<WorkBoard, 'peak' | 'span'> }) {
  return <div className={styles.work} data-work={work.kind}>
    <span className={styles.label}>Last {board.span}</span>
    <span className={styles.strip} role="img" aria-label={work.spoken}>
      {work.columns.map(column => <span key={column.start} className={styles.column} data-merged={column.merged > 0 || undefined}>
        <span className={styles.bar}><i style={{ height: `${barHeight(column.launched, board.peak)}%` }} /></span>
        <span className={styles.mark} />
      </span>)}
    </span>
    <span className={styles.words}>{work.words}</span>
  </div>;
}

/** Above the cards: the fleet's sentence for the window, what no row counts, and how to read a card's bars. */
export function WorkSummary({ board }: { board: WorkBoard }) {
  const bar = board.columnHours === 1 ? 'one hour' : `${board.columnHours} hours`;
  return <div className={styles.summary} data-work-state={board.state}>
    <p className={styles.line} data-unknown={board.state === 'unread' || undefined} role={board.state === 'unread' ? 'status' : undefined}>{board.line}</p>
    {board.unnamed ? <p className={styles.line}>{board.unnamed}</p> : null}
    {board.state === 'ok' ? <p className={styles.line}>
      <span className={styles.key}><i data-part="bar" />jobs launched, a bar per {bar} (tallest: {board.peak})</span>
      <span className={styles.key}><i data-part="mark" />a PR merged</span>
      <span>Same data: <code>phm throughput --by model</code></span>
    </p> : null}
  </div>;
}
