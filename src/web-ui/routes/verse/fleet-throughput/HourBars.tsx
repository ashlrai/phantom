/** One row of bars across the Throughput window: a bar per hour (or per 7 hours over 7 days) as tall as the jobs
 * launched in it, with a mark under each bar that had a PR merged. The Models board draws its work line the same way.
 *
 * Every row is also the board's reading cursor. Pointing at a bar, or Left / Right / Home / End on a focused row,
 * holds that stretch of time on the fleet row and on every lane card at once, and the figure tiles become that
 * bar's own counts. Esc, leaving the bars with the pointer, or moving focus off the rows lets go. The cursor is the
 * bar's start time and lives in the pane, so every row follows it. */
import type { KeyboardEvent } from 'react';
import { barHeight, cursorAt, cursorMove } from '../models/model-work-model.js';
import styles from './hour-bars.module.css';
import { barUnit, barWords, busiestWords, mostLaunched, type HourBar } from './throughput-cursor-model.js';

const isRow = (node: unknown): boolean => node instanceof HTMLElement && node.hasAttribute('data-hour-bars');

export interface HourCursor { cursor: string | null; onCursor: (start: string | null) => void }

export function HourBars({ bars, peak, label, say, size = 'card', cursor, onCursor }: HourCursor & {
  bars: readonly HourBar[];
  /** The count a full-height bar stands for: rows drawn against the same peak compare. */
  peak: number;
  /** The row's name: whose bars, and what they count. */
  label: string;
  /** One bar in words, for the value read aloud. */
  say: (bar: HourBar) => string;
  size?: 'card' | 'fleet';
}) {
  if (bars.length === 0) return null;
  const last = bars.length - 1, at = cursorAt(bars, cursor);
  const key = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = cursorMove(bars, cursor, event.key);
    if (next === undefined) return;
    // Escape is taken only while a bar is held, so the next one still reaches whatever closes the pane.
    event.preventDefault();
    event.stopPropagation();
    onCursor(next);
  };
  return <span className={styles.row} data-hour-bars data-size={size} data-cursor={at === null ? undefined : ''}
    role="slider" tabIndex={0} aria-label={label} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={bars.length}
    aria-valuenow={(at ?? last) + 1} aria-valuetext={say(bars[at ?? last]!)} onKeyDown={key}
    onFocus={() => { if (at === null) onCursor(bars[last]!.start); }}
    onBlur={event => { if (!isRow(event.relatedTarget)) onCursor(null); }}
    onMouseLeave={() => { if (!isRow(document.activeElement)) onCursor(null); }}>
    {bars.map((bar, index) => <span key={bar.start} className={styles.column} data-at={index === at || undefined}
      data-merged={bar.merged > 0 || undefined} data-unread={bar.read ? undefined : ''} onMouseEnter={() => onCursor(bar.start)}>
      <span className={styles.bar}><i style={{ height: `${barHeight(bar.launched, Math.max(1, peak))}%` }} /></span>
      <span className={styles.mark} />
    </span>)}
  </span>;
}

/** Under the figure tiles: the fleet's own hours, the sentence for the held bar (or the busiest one), and how to read every row. */
export function ThroughputHours({ bars, cursor, onCursor }: HourCursor & { bars: readonly HourBar[] }) {
  if (bars.length === 0) return null;
  const at = cursorAt(bars, cursor), unit = barUnit(bars[0]!), most = mostLaunched([bars]);
  return <div className={styles.hours} data-throughput-hours>
    <HourBars size="fleet" bars={bars} peak={most} cursor={cursor} onCursor={onCursor} say={barWords}
      label={`Fleet jobs launched, a bar per ${unit}: most in one bar ${most}`} />
    {at === null ? <p className={styles.line}>{busiestWords(bars)}.</p> : <p className={styles.line} data-cursor-line>{barWords(bars[at]!)}</p>}
    <p className={styles.key}>
      <span><i data-part="bar" />jobs launched, a bar per {unit}</span>
      <span><i data-part="mark" />a PR merged</span>
      <span>Point at a bar, or press Left and Right on a row of bars, to read that time on every figure and lane</span>
    </p>
  </div>;
}
