/**
 * routes/verse/goals-pane/GoalAddForm.tsx: the Goals pane's one-line "Add a
 * goal" form — the pane's only write besides a Leader steer line. POSTs
 * {objective} to /api/verse/goals, the same createGoalIfAbsent the CLI
 * reaches, then re-reads the goals list so the new card appears without a
 * restart. Server strings render as React text only.
 */
import { useState, type FormEvent } from 'react';
import { apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { goalsQuery } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';
import { goalAddErrorText, goalAddNotice, goalAddParse } from './goal-add-model.js';
import styles from './goals-pane.module.css';

/** POST /api/verse/goals' response (goals-create-api.ts); fields beyond status are the server's to confirm. */
interface GoalCreateResponse { schema: string; status: 'created' | 'exists'; goal: { id: string; objective: string; status: string } }

async function postGoalAdd(objective: string): Promise<GoalCreateResponse> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const res = await apiPost<GoalCreateResponse>('/api/verse/goals', { objective }, token);
  touchMutationHold();
  return res;
}

export function GoalAddForm() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setNote(null);
    const parsed = goalAddParse(text);
    if (!parsed.ok) { setError(parsed.reason); return; }
    setError(null);
    setSending(true);
    try {
      const body = await postGoalAdd(parsed.objective);
      setText('');
      setNote(goalAddNotice(body));
      invalidate(goalsQuery.key);
    } catch (err) {
      setError(goalAddErrorText(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className={styles.steer} onSubmit={(event) => void submit(event)}>
      <input
        type="text"
        value={text}
        aria-label="New goal objective"
        placeholder="Add a goal, e.g. ship the desktop release"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" disabled={sending || !text.trim()}>{sending ? 'Adding…' : 'Add'}</button>
      {note ? <span className={styles.meta}>{note}</span> : null}
      {error ? <span role="alert" className={styles.meta}>{error}</span> : null}
    </form>
  );
}
