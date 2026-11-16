/**
 * routes/verse/ideas/IdeaNotNow.tsx: "Not now" on one idea row — the other
 * answer to an idea Mason does not want (RQ-PHX-IDEANOTNOW94). Opens an
 * inline one-line reason field (optional) with Not now / Never / Cancel and
 * posts the verdict to `POST /api/ideas/verdict`. The pane applies the
 * verdict optimistically (the row leaves the list at once) and rolls it back
 * when the post fails; this control only owns the reason form.
 *
 * The label deliberately differs from IdeaSteer's "Not now" (which steers the
 * Leader through the fleet inbox): the aria-labels say "dismiss" so the two
 * buttons never share an accessible name.
 */
import { useState, type KeyboardEvent } from 'react';
import { apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import type { IdeaRowVerdict } from './ideas-model.js';
import styles from './ideas.module.css';

export async function postIdeaVerdict(ideaId: string, verdict: 'not-now' | 'never', reason: string): Promise<IdeaRowVerdict> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<{ ok?: boolean; entry?: IdeaRowVerdict }>(
    '/api/ideas/verdict',
    { ideaId, verdict, ...(reason ? { reason } : {}) },
    token,
  );
  touchMutationHold();
  return result?.entry ?? { verdict, reason, at: new Date().toISOString() };
}

export function IdeaNotNow({ ideaId, title, error, onVerdict }: {
  /** Backlog item id the verdict is keyed on; null disables dismissal. */
  ideaId: string | null;
  title: string;
  /** Post-failure message the pane keeps for this row; rendered as an alert. */
  error?: string | null;
  onVerdict: (verdict: 'not-now' | 'never', reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const cancel = () => { setOpen(false); setReason(''); };
  const submit = (verdict: 'not-now' | 'never') => {
    onVerdict(verdict, reason.trim());
    cancel();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  if (!open) {
    return (
      <>
        <button
          type="button"
          className={styles.toggle}
          disabled={ideaId === null}
          aria-label={`Not now — dismiss idea: ${title}`}
          onClick={() => setOpen(true)}
        >Not now</button>
        {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
      </>
    );
  }
  return (
    <span className={styles.steer}>
      <input
        type="text"
        autoFocus
        value={reason}
        aria-label={`Reason for dismissing idea: ${title}`}
        placeholder="Why not now? (optional)"
        onChange={e => setReason(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className={styles.toggle} aria-label="Confirm not now" onClick={() => submit('not-now')}>Not now</button>
      <button type="button" className={styles.toggle} onClick={() => submit('never')}>Never</button>
      <button type="button" className={styles.toggle} onClick={cancel}>Cancel</button>
      {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
    </span>
  );
}
