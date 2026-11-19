/**
 * "Since you last looked": the card above the Leader conversation when Mason comes back to it. It counts what
 * arrived while the pane was off screen, shows the newest thing the Leader said, and jumps to the first new
 * line. Read-only and request-free: it summarises what the pane already read. The last-looked moment lives in
 * localStorage and is refreshed while the pane is on screen, so closing the app mid-read still leaves it right.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { formatRelative } from '../autonomy/format.js';
import { useNow } from '../autonomy/use-ticker.js';
import type { Merged } from '../fleet-merges/fleet-merges-model.js';
import { clockTime, dayLabel } from '../leader/thread-model.js';
import { useDocumentVisible } from '../shell/section-visibility.js';
import { awayWindow, catchUp, catchUpParts, loadLastLooked, saveLastLooked, type AwayWindow } from './leader-catchup-model.js';
import type { BusReply } from './thread-bus-replies.js';
import type { MergedLine } from './thread-merge-model.js';
import styles from './leader-catchup.module.css';

const HEARTBEAT_MS = 10_000;

/** localStorage can be denied (private mode); the card then never appears, which is the honest read. */
function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LeaderCatchUp({ visible, lines, ownerLines, busRows, merged, asks, logRef }: {
  visible: boolean;
  /** The dated conversation lines, and the owner-channel lines shown among them. */
  lines: readonly MergedLine[];
  ownerLines: readonly MergedLine[];
  busRows: readonly BusReply[];
  /** Merged PRs from the fleet read; null while that read has not answered. */
  merged: readonly Merged[] | null;
  /** The Leader's questions the thread holds no answer to; they are answered in the tray above the reply box. */
  asks: readonly { atMs: number | null }[];
  /** The conversation log, searched for the first new line. */
  logRef: RefObject<HTMLElement | null>;
}) {
  // Looking means the pane is the shown one and the window itself is not hidden.
  const looking = useDocumentVisible() && visible;
  const [away, setAway] = useState<AwayWindow | null>(null);
  const now = useNow(30_000);

  useEffect(() => {
    if (!looking) return;
    const returnedAt = Date.now();
    // A short look away keeps the card that was already up; only a real absence opens a new window.
    setAway(previous => awayWindow(loadLastLooked(storage()), returnedAt) ?? previous);
    saveLastLooked(storage(), returnedAt);
    const beat = setInterval(() => saveLastLooked(storage(), Date.now()), HEARTBEAT_MS);
    return () => { clearInterval(beat); saveLastLooked(storage(), Date.now()); };
  }, [looking]);

  const view = useMemo(() => (away ? catchUp({ lines: [...lines, ...ownerLines], busRows, merged, asks }, away) : null), [away, lines, ownerLines, busRows, merged, asks]);
  if (!view || view.total === 0) return null;

  const sinceIso = new Date(view.since).toISOString();
  const day = dayLabel(sinceIso, now);
  const parts = catchUpParts(view);

  function jump() {
    const log = logRef.current;
    if (!log || view?.firstNewAt == null) return;
    const first = view.firstNewAt;
    const stamp = [...log.querySelectorAll<HTMLTimeElement>('time[datetime]')].find(el => Date.parse(el.dateTime) >= first);
    const row = stamp?.closest<HTMLElement>('section, p') ?? stamp;
    if (!row) return;
    const calm = reducedMotion();
    row.scrollIntoView?.({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    // A brief wash on the landing line, so the eye finds where "new" starts.
    if (!calm) row.animate?.([{ backgroundColor: 'var(--bg-hover)' }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  }

  return <section className={styles.card} aria-label="Since you last looked" data-attention={view.needsYou + view.questions > 0 ? 'true' : undefined}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAway(null); } }}>
    <header className={styles.head}>
      <h3 className={styles.title}>Since you last looked</h3>
      <time className={styles.when} dateTime={sinceIso} title={new Date(view.since).toLocaleString('en-US')}>
        {day === 'Today' ? '' : `${day} `}{clockTime(sinceIso)} · {formatRelative(sinceIso, now)}
      </time>
      <span className={styles.actions}>
        {view.firstNewAt !== null ? <button type="button" className={styles.action} onClick={jump}>Jump to first new</button> : null}
        <button type="button" className={styles.action} onClick={() => setAway(null)}>Caught up</button>
      </span>
    </header>
    <ul className={styles.parts} aria-label="What arrived">
      {parts.map(part => <li key={part.key} data-tone={part.tone}>{part.text}</li>)}
    </ul>
    {view.latest ? <p className={styles.latest}>
      <span className={styles.latestLabel}>Latest from the Leader</span>
      <span className={styles.latestText} title={view.latest.text}>{view.latest.text}</span>
    </p> : null}
  </section>;
}
