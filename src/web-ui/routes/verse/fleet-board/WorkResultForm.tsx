/**
 * WorkResultForm.tsx — inline "Record result" form under a Fleet Board work row
 * (RQ-PHX-WORKRESULTFORM340). POSTs /api/verse/fleet/work-board/result. The
 * replyId is minted when the form opens and reused for every retry, so the
 * server dedupes a repeated submission. All text is rendered as plain text.
 */
import { useId, useRef, useState } from 'react';
import { ApiError, apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';
import styles from './fleet-board.module.css';
import {
  buildWorkResultBody, describeWorkResultError, newReplyId,
  type WorkResultKind,
} from './work-result-form-model.js';

const KINDS: ReadonlyArray<{ kind: WorkResultKind; label: string }> = [
  { kind: 'pr', label: 'PR + head' },
  { kind: 'tests', label: 'Tests' },
  { kind: 'artifact', label: 'Artifact' },
  { kind: 'blocked', label: 'Blocked' },
];

export function WorkResultForm({ requestId, onDone, onCancel }: {
  requestId: string;
  /** Called after a 200 so the board can refetch. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const replyId = useRef<string | null>(null);
  if (replyId.current === null) replyId.current = newReplyId();
  const uid = useId();
  const [kind, setKind] = useState<WorkResultKind>('tests');
  const [value, setValue] = useState('');
  const [head, setHead] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight || done) return;
    const built = buildWorkResultBody({ kind, value, head });
    if (!built.ok) { setError(built.message); return; }
    setInFlight(true); setError('');
    try {
      const token = getMutationToken();
      if (!token) throw new Error('Authorize console mutations before recording a result.');
      const res = await apiPost<{ outcome?: string }>(
        '/api/verse/fleet/work-board/result',
        { requestId, replyId: replyId.current, result: built.result },
        token,
      );
      setDone(res?.outcome === 'duplicate' ? 'Already recorded (duplicate)' : 'Recorded (posted)');
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? describeWorkResultError(cause.status)
        : cause instanceof Error ? cause.message : 'Could not record the result.');
    } finally { setInFlight(false); }
  };

  const valueLabel = kind === 'pr' ? 'PR number' : kind === 'tests' ? 'Tests run' : kind === 'artifact' ? 'Artifact' : 'Blocked on';
  return (
    <form className={styles.resultForm} onSubmit={submit} aria-label={`Record result for ${requestId}`}>
      <label htmlFor={`${uid}-kind`}>Result kind</label>
      <select id={`${uid}-kind`} value={kind} disabled={inFlight || !!done}
        onChange={(e) => { setKind(e.target.value as WorkResultKind); setError(''); }}>
        {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>
      <label htmlFor={`${uid}-value`}>{valueLabel}</label>
      <input id={`${uid}-value`} type="text" value={value} disabled={inFlight || !!done}
        maxLength={kind === 'blocked' ? 200 : undefined} onChange={(e) => setValue(e.target.value)} />
      {kind === 'pr' ? (
        <>
          <label htmlFor={`${uid}-head`}>Head commit</label>
          <input id={`${uid}-head`} type="text" value={head} disabled={inFlight || !!done}
            onChange={(e) => setHead(e.target.value)} />
        </>
      ) : null}
      <button type="submit" disabled={inFlight || !!done}>{inFlight ? 'Recording…' : 'Submit'}</button>
      <button type="button" onClick={onCancel} disabled={inFlight}>{done ? 'Close' : 'Cancel'}</button>
      {error ? <span role="alert" className={styles.note}>{error}</span> : null}
      {done ? <span role="status" className={styles.note}>{done}</span> : null}
    </form>
  );
}
