import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { ApiError } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { closeInterjectDialog, postInterjection, useInterjectDialogOpen } from './interject-dialog-store.js';
import styles from './interject-dialog.module.css';

function errorMessage(error: unknown): string {
  if (error instanceof VerseMutationLockedError) return 'Unlock actions with the mutation token first.';
  if (error instanceof ApiError && error.status === 404) return 'This build has no fleet inbox route yet.';
  if (error instanceof ApiError && error.status === 400) return error.detail ?? 'The message was rejected.';
  return 'The message could not be sent. Try again.';
}

export function InterjectDialog() {
  const open = useInterjectDialogOpen();
  return open ? <InterjectDialogBody /> : null;
}

function InterjectDialogBody() {
  const titleId = useId();
  const fieldId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  const sending = useRef(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [landed, setLanded] = useState('');

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!landed) return;
    const timer = window.setTimeout(closeInterjectDialog, 2000);
    return () => window.clearTimeout(timer);
  }, [landed]);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (sending.current || landed) return;
    const trimmed = text.trim();
    if (!trimmed) { setError('Enter a message first.'); return; }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const at = await postInterjection(trimmed);
      if (!active.current) return;
      const date = new Date(at);
      setText('');
      setLanded(`${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
    } catch (err) {
      if (active.current) setError(errorMessage(err));
    } finally {
      sending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <Dialog open onClose={closeInterjectDialog} titleId={titleId} title="Tell the fleet leaders"
      description="Lands in the leaders' inbox. The next leader pass reads it (every 15–20 min)." initialFocusRef={inputRef}>
      <form onSubmit={(event) => { void send(event); }} className={styles.form}>
        <label htmlFor={fieldId}>Message</label>
        <textarea id={fieldId} ref={inputRef} rows={6} maxLength={6000} value={text} disabled={busy || !!landed}
          aria-invalid={!!error} aria-describedby={`${fieldId}-count${error ? ` ${fieldId}-error` : ''}`}
          onChange={(event) => { setText(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) { event.preventDefault(); void send(); } }} />
        <div id={`${fieldId}-count`} className={styles.counter} aria-live="polite">{text.length} / 6000</div>
        {error ? <p id={`${fieldId}-error`} className={styles.error} role="alert">{error}</p> : null}
        {landed ? <p className={styles.landed} role="status">Landed at {landed} — the leaders read newest first</p> : null}
        <div className={styles.actions}>
          <Button onClick={closeInterjectDialog}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={!!landed}>Send (⌘↵)</Button>
        </div>
      </form>
    </Dialog>
  );
}
