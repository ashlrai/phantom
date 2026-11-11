/**
 * routes/verse/feed/AwayDigestCard.tsx: the dismissible "While you were away"
 * line at the top of the Feed (away-digest.ts builds its parts). Clicking a
 * part filters the Feed to that kind; Dismiss marks the period seen — both are
 * the caller's, so the card stays presentational.
 */
import { Fragment } from 'react';
import type { AwayDigest } from './away-digest.js';
import type { FeedFilter } from './feed-model.js';
import styles from './feed.module.css';

export function AwayDigestCard({ digest, onFilter, onDismiss }: {
  digest: AwayDigest;
  onFilter: (filter: FeedFilter) => void;
  onDismiss: () => void;
}) {
  return <div className={styles.newBar} role="note" aria-label="While you were away">
    <span>While you were away ({digest.awayFor}):</span>
    <span>
      {digest.parts.map((part, index) => <Fragment key={part.id}>
        {index > 0 ? ' · ' : null}
        {part.filter
          ? <button type="button" className={styles.link} onClick={() => { if (part.filter) onFilter(part.filter); }}>{part.text}</button>
          : part.text}
      </Fragment>)}
    </span>
    <button type="button" className={styles.dismiss} onClick={onDismiss}>Dismiss</button>
  </div>;
}
