/**
 * Keeps the Leader reply box's draft. What Mason types is written to this browser's storage as he types, put
 * back when the pane opens again (after a reload, a crash, or closing the window), and forgotten once it is
 * sent or discarded. It also says how much room is left when the draft nears the box's limit. Mounted inside
 * the reply form; it renders nothing while there is nothing to say.
 *
 * Two windows share the one kept draft. A window with an empty box never touches it, and when the draft is
 * sent or discarded in one window, another window still holding the same text clears its copy, so it is not
 * sent twice.
 */
import { useEffect, useRef, useState } from 'react';
import { draftStorage, limitNote, loadDraft, parseDraft, REPLY_DRAFT_KEY, restoredLabel, saveDraft, type SavedDraft } from './reply-draft-model.js';
import styles from './reply-draft.module.css';

export interface ReplyDraftProps {
  draft: string;
  onDraft: (text: string) => void;
}

export function ReplyDraft({ draft, onDraft }: ReplyDraftProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [restored, setRestored] = useState<{ saved: SavedDraft; label: string } | null>(() => {
    const saved = loadDraft(draftStorage());
    return saved ? { saved, label: restoredLabel(saved, Date.now()) } : null;
  });
  const [failed, setFailed] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  /** The kept draft still on its way into the box; while it is, the empty box must not erase it. */
  const pending = useRef<string | null>(restored?.saved.text ?? null);
  /** What this window last read from or wrote to storage; null when it holds nothing of this window's. */
  const known = useRef<string | null>(restored?.saved.text ?? null);
  const live = useRef({ draft, onDraft });
  live.current = { draft, onDraft };

  useEffect(() => {
    if (pending.current !== null) live.current.onDraft(pending.current);
  }, []);

  useEffect(() => {
    if (draft.trim() === '') {
      if (pending.current !== null) return;
      setRestored(null);
      if (known.current === null) return;
      known.current = null;
      saveDraft(draftStorage(), '', Date.now());
      setFailed(false);
      return;
    }
    pending.current = null;
    if (draft === known.current) return;
    known.current = draft;
    setRestored(null);
    setElsewhere(false);
    setFailed(saveDraft(draftStorage(), draft, Date.now()) === 'failed');
  }, [draft]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== REPLY_DRAFT_KEY || event.newValue !== null) return;
      const gone = parseDraft(event.oldValue);
      if (!gone || gone.text !== live.current.draft) return;
      known.current = null;
      setElsewhere(true);
      live.current.onDraft('');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const limit = limitNote(draft.length);
  const showRestored = restored !== null && draft === restored.saved.text;
  const unsaved = failed && draft.trim() !== '';
  if (!showRestored && !limit && !unsaved && !elsewhere) return null;

  function discard() {
    const box = rootRef.current?.closest('form')?.querySelector('textarea');
    onDraft('');
    box?.focus();
  }

  return <div ref={rootRef} className={styles.root}>
    {showRestored ? <p className={styles.line} data-kind="restored">
      <span className={styles.dot} aria-hidden="true" />
      <span title={restored.saved.at === null ? undefined : new Date(restored.saved.at).toLocaleString('en-US')}>{restored.label} It is kept on this computer until you send it.</span>
      <button type="button" className={styles.action} onClick={discard}>Discard draft</button>
    </p> : null}
    {elsewhere ? <p className={styles.line} role="status">
      <span>This draft was sent or discarded in another window, so it was cleared here.</span>
      <button type="button" className={styles.action} onClick={() => setElsewhere(false)}>Dismiss</button>
    </p> : null}
    {unsaved ? <p className={styles.line} data-kind="unsaved" role="status">This draft is not being kept: browser storage is unavailable. It lasts only while this pane stays open.</p> : null}
    {limit ? <p className={styles.line} data-kind={limit.tone} role={limit.tone === 'full' ? 'status' : undefined}>
      <span className={styles.meter} aria-hidden="true"><span className={styles.fill} style={{ inlineSize: `${Math.round(limit.fill * 100)}%` }} /></span>
      <span>{limit.text}</span>
    </p> : null}
  </div>;
}
