/** routes/verse/feed/FeedAskButton.tsx: "Ask Leader" on a Feed item; fills the Leader composer and switches home to it, never sends. */
import { setLeaderDraft } from '../leader-thread/leader-draft-store.js';
import { setHomeChoice } from '../shell/home-view-store.js';
import { askLeaderDraft } from './feed-ask.js';
import type { FeedItem } from './feed-model.js';
import styles from './feed.module.css';

export function FeedAskButton({ item }: { item: FeedItem }) {
  return <button type="button" className={styles.chip} aria-label={`Ask Leader about ${item.title.replace(/\s+/g, ' ').trim()}`}
    onClick={() => { setLeaderDraft(askLeaderDraft(item)); setHomeChoice('leader'); }}>Ask Leader</button>;
}
