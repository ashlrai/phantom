/**
 * The work line at the foot of a Models board card: the jobs launched on that model across the window as one row of
 * bars (drawn against the busiest bar on the whole board, so cards compare), a mark under each bar that had a PR
 * merged, and the counts in words. It draws only what `phm throughput --by model` reports for that model; a model
 * with nothing recorded is an empty line, and a report that could not be read is hatched and says unknown.
 *
 * A row with bars is also the board's reading cursor: pointing at a bar, or Left / Right / Home / End on the focused
 * row, holds that stretch of time on every card at once, and each card's words become that bar's own counts. Esc,
 * leaving the bars with the pointer, or moving focus off the rows lets go. The cursor is the bar's start time and
 * lives in the pane, so every row follows it.
 *
 * The Lanes board draws the same line on its lane cards from the per-lane report (fleet-lanes/LaneWork.tsx).
 */
import type { KeyboardEvent } from 'react';
import { barHeight, columnWhen, columnWords, cursorAt, cursorLine, cursorMove, type ModelWork, type WorkBoard } from './model-work-model.js';
import styles from './model-work.module.css';

const isStrip = (node: unknown): boolean => node instanceof HTMLElement && node.hasAttribute('data-work-strip');

export function ModelWorkLine({ work, board, cursor = null, onCursor }: {
  work: ModelWork; board: Pick<WorkBoard, 'peak' | 'span'>; cursor?: string | null; onCursor?: (start: string | null) => void;
}) {
  const columns = work.columns;
  const at = cursorAt(columns, cursor);
  const held = at === null ? null : columns[at]!;
  const said = (index: number) => `${columnWhen(columns[index]!)}: ${columnWords(columns[index]!)}`;
  const key = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = cursorMove(columns, cursor, event.key);
    if (next === undefined) return;
    // Escape is taken only while a bar is held, so the next one still reaches whatever closes the pane.
    event.preventDefault();
    event.stopPropagation();
    onCursor?.(next);
  };
  // A slider: one value per bar, the newest when none is held. Rows without bars stay a picture.
  const scrub = onCursor && columns.length > 0 ? {
    role: 'slider', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-valuemin': 1, 'aria-valuemax': columns.length,
    'aria-valuenow': (at ?? columns.length - 1) + 1, 'aria-valuetext': said(at ?? columns.length - 1),
    onKeyDown: key,
    onFocus: () => { if (at === null) onCursor(columns[columns.length - 1]!.start); },
    onBlur: (event: { relatedTarget: unknown }) => { if (!isStrip(event.relatedTarget)) onCursor(null); },
    onMouseLeave: () => { if (!isStrip(document.activeElement)) onCursor(null); },
  } as const : { role: 'img' } as const;
  return <div className={styles.work} data-work={work.kind}>
    <span className={styles.label}>Last {board.span}</span>
    <span className={styles.strip} data-work-strip data-cursor={held ? '' : undefined} aria-label={work.spoken} {...scrub}>
      {columns.map(column => <span key={column.start} className={styles.column} data-merged={column.merged > 0 || undefined}
        data-at={column === held || undefined} onMouseEnter={onCursor ? () => onCursor(column.start) : undefined}>
        <span className={styles.bar}><i style={{ height: `${barHeight(column.launched, board.peak)}%` }} /></span>
        <span className={styles.mark} />
      </span>)}
    </span>
    {held ? <span className={styles.words} data-reading>{said(at!)}</span> : <span className={styles.words}>{work.words}</span>}
  </div>;
}

/** Above the cards: the fleet's sentence for the window (or for the held bar), what no row counts, and how to read a card's bars. */
export function WorkSummary({ board, cursor = null, announce = true }: {
  board: WorkBoard; cursor?: string | null;
  /** False where the work line is a second reading of a pane that already announces its own (Lanes): no live region of its own. */
  announce?: boolean;
}) {
  const bar = board.columnHours === 1 ? 'one hour' : `${board.columnHours} hours`;
  const reading = board.state === 'ok' ? cursorLine(board, cursor) : null;
  return <div className={styles.summary} data-work-state={board.state}>
    {reading ? <p className={styles.line} data-cursor-line>{reading}</p>
      : <p className={styles.line} data-unknown={board.state === 'unread' || undefined} role={announce && board.state === 'unread' ? 'status' : undefined}>{board.line}</p>}
    {board.unnamed ? <p className={styles.line}>{board.unnamed}</p> : null}
    {board.state === 'ok' ? <p className={styles.line}>
      <span className={styles.key}><i data-part="bar" />jobs launched, a bar per {bar} (tallest: {board.peak})</span>
      <span className={styles.key}><i data-part="mark" />a PR merged</span>
      <span>Point at a bar, or press Left and Right on a row, to read that time on every card</span>
      <span>Same data: <code>phm throughput --by {board.by}</code></span>
    </p> : null}
  </div>;
}
