/**
 * routes/verse/ideas/IdeaSteer.tsx: "Do next" / "Not now" on one idea row.
 * Sends a tagged line through the existing fleet inbox interject client (the
 * only MASON-INBOX.md writer). The last verdict per idea is kept in memory for
 * the session only.
 */
import { useState, type KeyboardEvent } from 'react';
import { postFleetInterjection } from '../composer/fleet-interject.js';
import { ideaSteerText, ideaSteeredLabel, type IdeaVerdict } from './idea-steer-model.js';
import styles from './ideas.module.css';

const lastVerdict = new Map<string, { verdict: IdeaVerdict; at: number }>();

export function IdeaSteer({ idea, repo }: { idea: { key: string; title: string }; repo: string }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(lastVerdict.get(idea.key));

  const send = async (verdict: IdeaVerdict) => {
    const line = ideaSteerText({ title: idea.title, repo }, verdict, note);
    if (!line || sending) return;
    setSending(true);
    setError(null);
    try {
      await postFleetInterjection(line);
      const entry = { verdict, at: Date.now() };
      lastVerdict.set(idea.key, entry);
      setSent(entry);
      setNote('');
      setNoteOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  };
  // Enter on the note box sends "Do next"; "Not now" is always a button click.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void send('do-next'); }
    else if (e.key === 'Escape') setNoteOpen(false);
  };

  return (
    <div className={styles.steer}>
      <button type="button" className={styles.toggle} disabled={sending} onClick={() => void send('do-next')}>Do next</button>
      <button type="button" className={styles.toggle} disabled={sending} onClick={() => void send('not-now')}>Not now</button>
      <button type="button" className={styles.toggle} aria-expanded={noteOpen} onClick={() => setNoteOpen(o => !o)}>Add note</button>
      {noteOpen ? (
        <input
          type="text"
          autoFocus
          value={note}
          aria-label={`Note for idea: ${idea.title}`}
          placeholder="Optional note, Enter sends Do next"
          onChange={e => setNote(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : null}
      {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
      {sent && !error ? <span className={styles.meta}>{ideaSteeredLabel(sent.verdict, sent.at, Date.now())}</span> : null}
    </div>
  );
}
