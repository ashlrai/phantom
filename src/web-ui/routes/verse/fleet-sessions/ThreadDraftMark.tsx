/**
 * "Draft" on a session's card or row: words typed to that session and not sent
 * are waiting in its reply box (thread-draft-store.ts). Nothing is drawn for a
 * session without one, or where its reply box is already on screen.
 */
import { setThreadDraft, useHasThreadDraft, useThreadDraft } from './thread-draft-store.js';
import styles from './thread-draft.module.css';

export const DRAFT_MARK_TITLE = 'Words you typed to this session and did not send. They are kept in this browser until you send or clear them.';

export function ThreadDraftMark({ id, open = false, markId }: { id: string; /** Its conversation, and so its reply box, is on screen. */ open?: boolean; markId?: string }) {
  const kept = useHasThreadDraft(id);
  return kept && !open ? <span id={markId} className={styles.mark} data-draft-mark={id} title={DRAFT_MARK_TITLE}>Draft</span> : null;
}

/**
 * In place of the reply box of a session that no longer takes a message: the words that were waiting for it, so a
 * draft is never kept out of sight. They can be selected and copied; Discard forgets them.
 */
export function DraftLeft({ id }: { id: string }) {
  const [draft] = useThreadDraft(id);
  if (draft.trim() === '') return null;
  return <div className={styles.left} data-draft-left={id}>
    <p>You had typed this and not sent it. It is kept in this browser.</p>
    <p className={styles.words}>{draft}</p>
    <button type="button" className={styles.discard} onClick={() => setThreadDraft(id, '')}>Discard the draft</button>
  </div>;
}
