/**
 * Under the wall's headline when the list holds more sessions than the read
 * carries: which kind is off screen (wall-unshown.ts), in the warning tone
 * only when one of them may still be working, with "Running only" where that
 * narrowing could bring more of them on.
 */
import type { SessionWallRead, WallScope } from './session-wall-model.js';
import { unshownNotice } from './wall-unshown.js';
import styles from './wall-unshown.module.css';

export function WallUnshown({ read, scope, onRunningOnly }: { read: SessionWallRead; scope: WallScope; onRunningOnly?: () => void }) {
  const notice = unshownNotice(read, scope);
  if (notice === null) return null;
  return <p className={styles.unshown} data-unshown data-tone={notice.tone}>
    <span className={styles.dot} aria-hidden="true" />
    <span className={styles.text}>{notice.text}</span>
    {notice.offerRunning && onRunningOnly && <button type="button" className={styles.only} onClick={onRunningOnly}
      title="Ask for running sessions only, so the ended ones give up their places">Running only</button>}
  </p>;
}
