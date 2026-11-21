/**
 * components/primitives/WindowBar.tsx: how a usage window ends, as one bar. Left to right: the share used so
 * far (solid), the share the measured burn uses before the reset (the same colour, lighter), then the share
 * left unused at the reset (an empty stretch outlined in amber). Home's pool tiles, Home's "Most at risk" card
 * and the Pools board cards all draw this bar, so the same picture means the same thing on each.
 *
 * It draws only the shares it is handed. A share that is null is not drawn: with no share at all the track is
 * hatched (no reading is never an empty bar), and with only `used` the rest stays a plain track (nothing is
 * projected). `ending="dry"` paints the fill amber: the window runs out before its reset. Read aloud as one
 * meter whose value text is the caller's sentence.
 */
import styles from './WindowBar.module.css';

export type WindowBarPart = 'used' | 'more' | 'unused' | 'elapsed';

export interface WindowBarProps {
  /** The meter's name: whose window, and what the value counts ("Claude used"). */
  label: string;
  /** The bar in words; what a screen reader says for the value. */
  valueText: string;
  /** The number behind the words, 0 to 100; null when there is none. */
  valueNow: number | null;
  /** Share used so far, 0 to 100; null = no reading of it. */
  used: number | null;
  /** Further share used by the reset at the measured burn; null = not projected. */
  more?: number | null;
  /** Share left unused at the reset; null = not projected. */
  unused?: number | null;
  /** Share of the window's time already gone: a marker across the bar. */
  elapsed?: number | null;
  /** `edge` is the 3px rule on a tile's bottom edge, too thin to outline the unused share; `bar` stands alone. */
  size?: 'edge' | 'bar';
  /** The caller's word for how the window ends, kept on the element as `data-ending`. */
  ending?: string;
  className?: string;
}

const share = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

export function WindowBar({ label, valueText, valueNow, used, more, unused, elapsed, size = 'bar', ending, className }: WindowBarProps) {
  const edge = size === 'edge';
  const parts: [WindowBarPart, number | null][] = [['used', share(used)], ['more', share(more)], ['unused', edge ? null : share(unused)]];
  // An edge is a hairline: a zero-width part there is nothing. Nothing left unused is no outline at any size.
  const drawn = parts.filter((part): part is [WindowBarPart, number] => part[1] !== null && (part[1] > 0 || (!edge && part[0] !== 'unused')));
  const unread = share(used) === null && share(more) === null && share(unused) === null;
  const at = share(elapsed);
  return <div role="meter" className={`${styles.track}${className ? ` ${className}` : ''}`} data-size={size} data-ending={ending} data-unread={unread || undefined}
    aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share(valueNow) === null ? undefined : Math.round(share(valueNow)!)} aria-valuetext={valueText}>
    {drawn.map(([part, percent]) => <i key={part} data-part={part} style={{ width: `${percent}%` }} />)}
    {at === null || unread ? null : <i data-part="elapsed" style={{ left: `${at}%` }} />}
  </div>;
}

/** The mark a key puts before the words for one part of the bar. Decorative: the words beside it carry the meaning. */
export function WindowBarSwatch({ part }: { part: WindowBarPart }) {
  return <i className={styles.swatch} data-part={part} aria-hidden="true" />;
}
