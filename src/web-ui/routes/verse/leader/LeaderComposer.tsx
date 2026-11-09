/**
 * routes/verse/leader/LeaderComposer.tsx — the Leader conversation's input:
 * a growing text box and one Send button. Deliberately NOT the chat
 * composer (no seats, models or slash commands, and one screenshot at most —
 * the Leader reads words).
 *
 *   Enter sends · Shift+Enter is a new line · an IME composition is never
 *   sent mid-word · an empty or whitespace box never sends.
 *
 * A screenshot pasted or dropped on the thread box uploads to local disk and
 * shows as a chip; Send adds its `[screenshot: <path>]` line (composer-attachment.ts).
 *
 * Also the inline answer box under a Leader question (`variant="answer"`):
 * the same keys, one line to start.
 */
import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { IconSend, IconX } from '../../../components/primitives/icons.js';
import { LEADER_MESSAGE_MAX } from './thread-model.js';
import { appendAttachmentRef, checkImage, formatBytes, pickImage, uploadAttachment } from './composer-attachment.js';
import { insertDictation } from '../voice/insert-text.js';
import styles from './leader.module.css';

export interface LeaderComposerHandle {
  focus: () => void;
}

export interface LeaderComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text; the owner clears `value` when the send starts. */
  onSend: (text: string) => void;
  label: string;
  placeholder: string;
  /** Why sending is off right now (read-only session, route absent); null = on. */
  disabledReason?: string | null;
  variant?: 'thread' | 'answer';
  /** A line above the box ("Answering: …") with a way to drop it. */
  context?: { label: string; onClear: () => void } | null;
  autoFocus?: boolean;
  /** Grow up to this many lines before scrolling. */
  maxLines?: number;
}

// Dictation (voice/): lazy — none of it loads until a Leader box is on screen.
const VoiceInput = lazy(() => import('../voice/VoiceInput.js'));

/** Grow the box to its content, up to `maxLines`. */
function fit(el: HTMLTextAreaElement, maxLines: number): void {
  el.style.height = 'auto';
  const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
  const pad = el.offsetHeight - el.clientHeight;
  const max = line * maxLines + pad + 16;
  el.style.height = `${Math.min(el.scrollHeight + pad, max)}px`;
  el.style.overflowY = el.scrollHeight + pad > max ? 'auto' : 'hidden';
}

export const LeaderComposer = forwardRef<LeaderComposerHandle, LeaderComposerProps>(function LeaderComposer(
  { value, onChange, onSend, label, placeholder, disabledReason = null, variant = 'thread', context = null, autoFocus = false, maxLines = 8 },
  ref,
) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => boxRef.current?.focus({ preventScroll: false }) }), []);

  useEffect(() => {
    if (boxRef.current) fit(boxRef.current, maxLines);
  }, [value, maxLines]);

  // A FINAL dictated transcript lands at the caret (or the end).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const insertDictated = useCallback((chunk: string) => {
    const node = boxRef.current;
    const focused = node !== null && document.activeElement === node;
    const next = insertDictation(valueRef.current, chunk, focused ? node.selectionStart : null, focused ? node.selectionEnd : null);
    onChangeRef.current(next.value);
    requestAnimationFrame(() => boxRef.current?.setSelectionRange(next.caret, next.caret));
  }, []);

  // One screenshot: uploading → chip (thumbnail from an object URL, revoked on remove/unmount).
  const [shot, setShot] = useState<{ url: string; bytes: number; path: string | null } | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const dropShot = useCallback(() => {
    uploadRef.current?.abort();
    uploadRef.current = null;
    setShot((cur) => { if (cur) URL.revokeObjectURL(cur.url); return null; });
  }, []);
  useEffect(() => dropShot, [dropShot]);
  const attaching = shot !== null && shot.path === null;

  const attach = useCallback((file: File) => {
    const problem = checkImage(file);
    if (problem) { setShotError(problem); return; }
    dropShot();
    setShotError(null);
    const url = URL.createObjectURL(file);
    const abort = new AbortController();
    uploadRef.current = abort;
    setShot({ url, bytes: file.size, path: null });
    uploadAttachment(file, abort.signal).then(
      (done) => { if (!abort.signal.aborted) setShot({ url, bytes: file.size, path: done.path }); },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        URL.revokeObjectURL(url);
        setShot(null);
        setShotError(err instanceof Error ? err.message : 'The screenshot could not be attached.');
      },
    );
  }, [dropShot]);

  const imageEnabled = variant === 'thread' && disabledReason === null;
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = imageEnabled ? pickImage(event.clipboardData) : null;
    if (!file) return; // plain text paste: the browser's default
    event.preventDefault();
    attach(file);
  }
  function onDrop(event: DragEvent<HTMLTextAreaElement>) {
    const file = imageEnabled ? pickImage(event.dataTransfer) : null;
    if (!file) return;
    event.preventDefault();
    attach(file);
  }

  const trimmed = value.trim();
  const over = value.length > LEADER_MESSAGE_MAX;
  const sendReason = disabledReason ?? (attaching ? 'Attaching screenshot…' : null);
  const canSend = (trimmed.length > 0 || shot?.path != null) && !over && sendReason === null;

  const send = useCallback(() => {
    if (!canSend) return;
    if (shot?.path) {
      const next = appendAttachmentRef(trimmed, shot.path);
      if (next.error !== undefined) { setShotError(next.error); return; }
      dropShot();
      setShotError(null);
      onSend(next.text);
      return;
    }
    onSend(trimmed);
  }, [canSend, dropShot, onSend, shot, trimmed]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    // Mid-composition (Japanese, Chinese, …) Enter picks a candidate, not "send".
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    // Keep the key from reaching a shell or drawer shortcut.
    event.stopPropagation();
    send();
  }

  const near = value.length > LEADER_MESSAGE_MAX * 0.9;
  return (
    <div className={styles.composer} data-variant={variant} data-disabled={disabledReason !== null ? 'true' : undefined}>
      {context ? (
        <div className={styles.composerContext}>
          <span className={styles.composerContextText} title={context.label}>{context.label}</span>
          <button type="button" className={styles.iconButton} aria-label="Stop answering this question" onClick={context.onClear}>
            <IconX />
          </button>
        </div>
      ) : null}
      <div className={styles.composerRow}>
        <textarea
          ref={boxRef}
          className={styles.composerBox}
          aria-label={label}
          placeholder={disabledReason ?? placeholder}
          value={value}
          rows={1}
          disabled={disabledReason !== null}
          // Only when the operator asked for this box (a Needs-you "Answer").
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          aria-invalid={over || undefined}
        />
        <Suspense fallback={null}>
          <VoiceInput surface="leader" targetRef={boxRef} disabled={disabledReason !== null} onInsert={insertDictated} />
        </Suspense>
        <button type="button" className={styles.send} aria-label={variant === 'answer' ? 'Send answer' : 'Send to the Leader'} disabled={!canSend} title={sendReason ?? undefined} onClick={send}>
          <IconSend />
        </button>
      </div>
      {shot ? (
        <div className={styles.composerChip}>
          <img className={styles.composerChipThumb} src={shot.url} alt="Attached screenshot" />
          <span>{attaching ? 'Attaching screenshot…' : `Screenshot · ${formatBytes(shot.bytes)}`}</span>
          <button type="button" className={styles.iconButton} aria-label="Remove screenshot" onClick={dropShot}>
            <IconX />
          </button>
        </div>
      ) : null}
      {shotError ? <p className={styles.composerHint} role="alert">{shotError}</p> : null}
      {variant === 'thread' ? (
        <p className={styles.composerHint}>
          {near ? (
            <span className={styles.counter} data-over={over ? 'true' : undefined}>
              {value.length.toLocaleString('en-US')} / {LEADER_MESSAGE_MAX.toLocaleString('en-US')}
            </span>
          ) : null}
          <span>
            <kbd className={styles.key}>↵</kbd> send · <kbd className={styles.key}>Shift</kbd> <kbd className={styles.key}>↵</kbd> new line
          </span>
        </p>
      ) : null}
    </div>
  );
});
