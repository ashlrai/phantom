/**
 * routes/verse/goals-pane/GoalSteer.tsx: one-line "Steer" control on an open
 * goal. Sends a goal-tagged line through the existing fleet inbox interject
 * client (the only MASON-INBOX.md writer). The last steer time per goal is kept
 * in memory for the session only.
 */
import { useState, type KeyboardEvent } from 'react';
import { postFleetInterjection } from '../composer/fleet-interject.js';
import { goalSteerText, steeredLabel } from './goal-steer-model.js';
import styles from './goals-pane.module.css';

const lastSteered = new Map<string, number>();

export function GoalSteer({ goal }: { goal: { id: string; objective: string } }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steeredAt, setSteeredAt] = useState<number | undefined>(lastSteered.get(goal.id));

  const line = goalSteerText(goal, text);
  const send = async () => {
    if (!line || sending) return;
    setSending(true);
    setError(null);
    try {
      await postFleetInterjection(line);
      const now = Date.now();
      lastSteered.set(goal.id, now);
      setSteeredAt(now);
      setText('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the steer.');
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void send(); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className={styles.steer}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>Steer</button>
      {open ? (
        <>
          <input
            type="text"
            autoFocus
            value={text}
            aria-label={`Steer goal: ${goal.objective}`}
            placeholder="Tell the Leader, e.g. push this harder"
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" disabled={!line || sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</button>
        </>
      ) : null}
      {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
      {steeredAt !== undefined && !error ? <span className={styles.meta}>{steeredLabel(steeredAt, Date.now())}</span> : null}
    </div>
  );
}
