/**
 * Reply box under the Mason thread on desktop. It posts through the same typed
 * Leader inbox action as the Leader chat (POST /api/verse/leader/inbox), so no
 * new channel exists and nothing goes to anyone outside the team. The phone
 * already has its own composer at the foot of the Leader screen, so the phone
 * card does not repeat this box.
 */
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { readFailureReason } from '../../../data/client.js';
import { refetchQuery } from '../../../data/cache.js';
import { inboxHeld } from '../leader-thread/inbox-held-model.js';
import { sendLeaderInboxMessage } from '../leader-thread/leader-inbox-data.js';
import { canSend, trimReply } from '../leader-thread/thread-reply-model.js';
import { masonThreadQuery } from './mason-thread-queries.js';
import styles from './mason-thread.module.css';

export function MasonThreadReply() {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const inFlight = useRef(false);

  async function send() {
    if (inFlight.current || !canSend(draft, sending)) return;
    if (!hasMutationHold()) { setUnlockOpen(true); return; }
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      await sendLeaderInboxMessage(trimReply(draft));
      setDraft('');
      // Refresh is separate from delivery: a read failure must not invite a resend.
      void refetchQuery(masonThreadQuery.key, () => masonThreadQuery.fetch(), true).catch(() => {});
    } catch (error) {
      setFailure(inboxHeld(error)?.reason ?? readFailureReason(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  return (
    <form className={styles.reply} onSubmit={onSubmit}>
      <textarea className={styles.box} rows={2} value={draft} disabled={sending} maxLength={6000} aria-label="Message the Leader"
        placeholder="Message the Leader. Enter sends, Shift+Enter adds a line." onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
      <button type="submit" className={styles.send} disabled={sending || !canSend(draft, sending)}>{sending ? 'Sending…' : 'Send'}</button>
      {failure && <p className={styles.failure} role="alert">Not sent. {failure}</p>}
      <MutationTokenDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} onUnlocked={() => void send()}
        reason="Messaging the Leader requires the dispatch token." tokenHelp="the mutation token ashlr verse printed" />
    </form>
  );
}
