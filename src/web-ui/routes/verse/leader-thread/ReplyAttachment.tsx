/**
 * Screenshots in the Leader pane's reply box: paste an image, drop one on the box, or pick a file. The image
 * uploads to this machine through the existing attachment route (leader/composer-attachment.ts) and its
 * `[screenshot: <path>]` line joins the draft, so Send needs nothing new and the thread shows the thumbnail.
 * Each marker in the draft shows here as a chip with Remove. Mounted inside the reply form, it listens on
 * that form, so a paste or drop anywhere in the reply area counts.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { ATTACHMENT_TYPES, checkImage, formatBytes, pickImage, uploadAttachment } from '../leader/composer-attachment.js';
import paneStyles from './leader-thread.module.css';
import { addShotLine, carriesFiles, draftShots, removeShotLine, shotMarker } from './reply-attachment-model.js';
import styles from './reply-attachment.module.css';

interface Thumb { url: string; bytes: number }

export interface ReplyAttachmentProps {
  draft: string;
  onDraft: (text: string) => void;
  /** Sending, or a read-only console: nothing can be attached. */
  disabled: boolean;
}

export function ReplyAttachment({ draft, onDraft, disabled }: ReplyAttachmentProps) {
  // The phone gateway does not carry the attachment route; it is desktop only, like the thumbnails.
  const remote = isRemoteMobileMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Thumb | null>(null);
  const [thumbs, setThumbs] = useState<Readonly<Record<string, Thumb>>>({});
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  /** The image waiting for the mutation token; it uploads as soon as the console is unlocked. */
  const [locked, setLocked] = useState<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const live = useRef({ draft, onDraft, disabled, thumbs, uploading });
  live.current = { draft, onDraft, disabled, thumbs, uploading };

  const attach = useCallback((file: File) => {
    const problem = checkImage(file);
    if (problem) { setError(problem); return; }
    if (abortRef.current) { setError('One screenshot is still attaching. Add the next when it is done.'); return; }
    setError(null);
    const abort = new AbortController(), thumb: Thumb = { url: URL.createObjectURL(file), bytes: file.size };
    abortRef.current = abort;
    setUploading(thumb);
    uploadAttachment(file, abort.signal).then(done => {
      if (abort.signal.aborted) return;
      abortRef.current = null;
      setUploading(null);
      const raw = shotMarker(done.path), next = addShotLine(live.current.draft, done.path);
      // The same file twice keeps its first chip; a draft with no room keeps no chip at all.
      if (next.error !== undefined || live.current.thumbs[raw]) URL.revokeObjectURL(thumb.url);
      if (next.error !== undefined) { setError(next.error); return; }
      setThumbs(current => (current[raw] ? current : { ...current, [raw]: thumb }));
      live.current.onDraft(next.text);
    }, (cause: unknown) => {
      if (abort.signal.aborted) return;
      abortRef.current = null;
      setUploading(null);
      URL.revokeObjectURL(thumb.url);
      if (cause instanceof VerseControlLockedError) setLocked(file);
      else setError(cause instanceof Error && cause.message !== '' ? cause.message : 'The screenshot could not be attached.');
    });
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setUploading(current => { if (current) URL.revokeObjectURL(current.url); return null; });
  }, []);

  // A chip lives as long as its marker: sending clears the draft, and deleting the line by hand detaches it.
  useEffect(() => {
    const gone = Object.keys(thumbs).filter(raw => !draft.includes(raw));
    if (gone.length === 0) return;
    for (const raw of gone) URL.revokeObjectURL(thumbs[raw]!.url);
    setThumbs(current => Object.fromEntries(Object.entries(current).filter(([raw]) => !gone.includes(raw))));
  }, [draft, thumbs]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (live.current.uploading) URL.revokeObjectURL(live.current.uploading.url);
    for (const thumb of Object.values(live.current.thumbs)) URL.revokeObjectURL(thumb.url);
  }, []);

  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form || remote) return;
    const onPaste = (event: ClipboardEvent) => {
      const file = live.current.disabled ? null : pickImage(event.clipboardData);
      if (!file) return; // text pastes into the box as usual
      event.preventDefault();
      attach(file);
    };
    const onDragOver = (event: DragEvent) => {
      if (live.current.disabled || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDropping(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !form.contains(event.relatedTarget)) setDropping(false);
    };
    const onDrop = (event: DragEvent) => {
      setDropping(false);
      if (live.current.disabled || !carriesFiles(event.dataTransfer)) return;
      // Claimed even when it is not an image: the browser would otherwise leave the app to open the file.
      event.preventDefault();
      const file = pickImage(event.dataTransfer);
      if (file) attach(file); else setError('Only PNG, JPEG or WebP screenshots can be attached.');
    };
    form.addEventListener('paste', onPaste);
    form.addEventListener('dragover', onDragOver);
    form.addEventListener('dragleave', onDragLeave);
    form.addEventListener('drop', onDrop);
    return () => {
      form.removeEventListener('paste', onPaste);
      form.removeEventListener('dragover', onDragOver);
      form.removeEventListener('dragleave', onDragLeave);
      form.removeEventListener('drop', onDrop);
    };
  }, [attach, remote]);

  if (remote) return null;
  const shots = draftShots(draft);
  return <div ref={rootRef} className={styles.root} data-dropping={dropping ? 'true' : undefined}
    // The unlock dialog's own form must not submit the reply form it is rendered inside.
    onSubmit={(event: FormEvent) => event.stopPropagation()}>
    <input ref={fileRef} type="file" hidden tabIndex={-1} aria-hidden="true" accept={ATTACHMENT_TYPES.join(',')} onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = ''; // the same file can be picked again after a failure
      if (file) attach(file);
    }} />
    {shots.length > 0 && <ul className={styles.chips} aria-label="Attached screenshots">{shots.map(shot => {
      const thumb = thumbs[shot.raw];
      return <li key={shot.raw} className={styles.chip}>
        {thumb ? <img className={styles.thumb} src={thumb.url} alt="" /> : <span className={styles.thumb} data-empty="true" aria-hidden="true" />}
        <span className={styles.label}>{thumb ? `Screenshot · ${formatBytes(thumb.bytes)}` : `Screenshot ${shot.name}`}</span>
        <button type="button" className={styles.remove} aria-label={`Remove screenshot ${shot.name}`} disabled={disabled}
          onClick={() => onDraft(removeShotLine(draft, shot.raw))}>Remove</button>
      </li>;
    })}</ul>}
    {uploading && <p className={styles.chip} data-busy="true" role="status">
      <img className={styles.thumb} src={uploading.url} alt="" />
      <span className={styles.label}>Attaching screenshot… {formatBytes(uploading.bytes)}</span>
      <button type="button" className={styles.remove} onClick={cancel}>Cancel</button>
    </p>}
    {error !== null && <p className={styles.error} role="alert">{error} <button type="button" className={styles.remove} onClick={() => setError(null)}>Dismiss</button></p>}
    <p className={styles.hint}>
      <button type="button" className={paneStyles.tool} disabled={disabled || uploading !== null} onClick={() => fileRef.current?.click()}>Attach screenshot</button>
      <span>{dropping ? 'Drop the image to attach it.' : 'Or paste or drop an image. It stays on this machine.'}</span>
    </p>
    <MutationTokenDialog open={locked !== null} onClose={() => setLocked(null)} onUnlocked={() => { if (locked) attach(locked); }}
      reason="Attaching a screenshot requires the dispatch token." tokenHelp="the mutation token ashlr verse printed" />
  </div>;
}
