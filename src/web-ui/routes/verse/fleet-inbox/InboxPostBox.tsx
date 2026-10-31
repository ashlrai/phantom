import { useId, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { loadDraft, saveDraft } from '../fleet/interject-ack-model.js';
import { postInterjection } from '../fleet/interject-queries.js';
import styles from './fleet-inbox.module.css';

export function InboxPostBox({ onPosted }: { onPosted: (text: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(() => {
    try { return loadDraft(window.sessionStorage); } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const canSend = !sending && draft.trim().length > 0 && draft.length <= 6_000;
  function updateDraft(value: string) {
    setDraft(value);
    try { saveDraft(window.sessionStorage, value); } catch { /* Storage can be unavailable. */ }
  }
  async function send() {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSending(true);
    setMessage('');
    const text = draft.trim();
    try {
      const result = await postInterjection(text);
      updateDraft('');
      setMessage(`Sent · ${result.at}`);
      onPosted(text);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.detail ?? error.message
        : error instanceof Error ? error.message : 'The message could not be sent.');
    } finally {
      busy.current = false;
      setSending(false);
    }
  }
  return <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
    <label htmlFor={id}>Prompt, thought or interjection</label>
    <textarea id={id} rows={3} maxLength={6_000} value={draft} disabled={sending}
      placeholder="Tell the leaders. Lands in MASON-INBOX.md."
      onChange={event => updateDraft(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape' || (event.key === 'Enter' && event.metaKey)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') updateDraft('');
          else void send();
        }
      }} />
    <div className={styles.composerActions}>
      <span>⌘↵ send · Esc clear</span>
      <span aria-live="polite">{draft.length > 5_000 ? `${draft.length.toLocaleString('en-US')} / 6,000` : ''}</span>
      <Button type="submit" variant="primary" size="sm" disabled={!canSend}>{sending ? 'Sending…' : 'Send'}</Button>
    </div>
    {message && <p role="status">{message}</p>}
  </form>;
}
