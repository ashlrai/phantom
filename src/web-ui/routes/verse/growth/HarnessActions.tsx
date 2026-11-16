import { useState } from 'react';
import type { LearningStateV1 } from '../../../../core/learn/harness-types.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import styles from './capability-gaps.module.css';
import { harnessActionOutcome, rollbackTarget, runningExperiments } from './harness-actions-model.js';

const ROLLBACK_PATH = '/api/verse/learning/rollback';
const CANCEL_PATH = '/api/verse/learning/experiments/cancel';

export function HarnessActions({ state, onChanged }: { state: LearningStateV1; onChanged: () => void }) {
  const { token, touch } = useMutationHold();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const target = rollbackTarget(state);
  const experiments = runningExperiments(state);

  async function change(path: string, body: unknown) {
    if (busy) return;
    if (!token) { setNote(harnessActionOutcome(401)); return; }
    setBusy(true);
    try {
      await apiPost(path, body, token);
      setNote(harnessActionOutcome(200));
      setConfirming(false);
      touch();
      onChanged();
    } catch (error) {
      setNote(harnessActionOutcome(error instanceof ApiError ? error.status : 0, error instanceof ApiError ? error.detail : null));
    } finally { setBusy(false); }
  }

  if (!target && experiments.length === 0) return null;
  return <section className={styles.panel} aria-label="Harness actions">
    <h3 className={styles.headline}>Harness in force: {state.active?.id ?? 'Baseline'}</h3>
    {target && (confirming ? <p>
      Roll back to {target.label}?{' '}
      <Button size="sm" disabled={busy} onClick={() => { void change(ROLLBACK_PATH, { toVersionId: target.toVersionId, reason: 'rolled back from Phantom desktop' }); }}>Confirm rollback</Button>{' '}
      <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>Keep current</Button>
    </p> : <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>Roll back to {target.label}</Button>)}
    {experiments.map(experiment => <p key={experiment.id}>
      Experiment {experiment.id} ({experiment.status}){' '}
      <Button size="sm" disabled={busy} onClick={() => { void change(CANCEL_PATH, { experimentId: experiment.id, reason: 'cancelled from Phantom desktop' }); }}>Cancel</Button>
    </p>)}
    {note && <p role="status">{note}</p>}
  </section>;
}
