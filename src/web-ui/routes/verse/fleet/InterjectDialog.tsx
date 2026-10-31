import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { ApiError } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { newestLeaderPassMs } from './interject-ack-model.js';
import { dialogDescription, landedText } from './interject-dialog-eta.js';
import { closeInterjectDialog, postInterjection, takeInterjectPrefill, useInterjectDialogOpen } from './interject-dialog-store.js';
import { inboxTailQuery } from './interject-queries.js';
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
  const read = useQuery(inboxTailQuery, { freshMs: 30_000 });
  const newestPass = newestLeaderPassMs(read.data?.leaders, Date.parse(read.data?.generatedAt ?? ''));
  const now = Date.now();
  const titleId = useId();
  const fieldId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  const sending = useRef(false);
  const pendingCaret = useRef<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [landed, setLanded] = useState<number | null>(null);

  useEffect(() => {
    const prefill = takeInterjectPrefill();
    if (prefill !== null) { pendingCaret.current = prefill; setText(prefill); }
  }, []);
  useEffect(() => {
    if (pendingCaret.current !== null && text === pendingCaret.current) {
      inputRef.current?.setSelectionRange(text.length, text.length);
      pendingCaret.current = null;
    }
  }, [text]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (landed === null) return;
    const timer = window.setTimeout(closeInterjectDialog, 2000);
    return () => window.clearTimeout(timer);
  }, [landed]);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (sending.current || landed !== null) return;
    const trimmed = text.trim();
    if (!trimmed) { setError('Enter a message first.'); return; }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const at = await postInterjection(trimmed);
      if (!active.current) return;
      setText('');
      setLanded(Date.parse(at));
    } catch (err) {
      if (active.current) setError(errorMessage(err));
    } finally {
      sending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <Dialog open onClose={closeInterjectDialog} titleId={titleId} title="Tell the fleet leaders"
      description={dialogDescription(newestPass, now)} initialFocusRef={inputRef}>
      <form onSubmit={(event) => { void send(event); }} className={styles.form}>
        <label htmlFor={fieldId}>Message</label>
        <textarea id={fieldId} ref={inputRef} rows={6} maxLength={6000} value={text} disabled={busy || landed !== null}
          aria-invalid={!!error} aria-describedby={`${fieldId}-count${error ? ` ${fieldId}-error` : ''}`}
          onChange={(event) => { setText(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) { event.preventDefault(); void send(); } }} />
        <div id={`${fieldId}-count`} className={styles.counter} aria-live="polite">{text.length} / 6000</div>
        {error ? <p id={`${fieldId}-error`} className={styles.error} role="alert">{error}</p> : null}
        {landed !== null ? <p className={styles.landed} role="status">{landedText(landed, newestPass, now)}</p> : null}
        <div className={styles.actions}>
          <Button onClick={closeInterjectDialog}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={landed !== null}>Send (⌘↵)</Button>
        </div>
      </form>
    </Dialog>
  );
}
