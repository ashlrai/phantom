import { useRef, useState } from 'react';
import styles from './UpdateNowButton.module.css';
import spinner from '../../../components/primitives/RefreshIndicator.module.css';
import { Button } from '../../../components/primitives/Button.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { applySelfUpdate, type ApplyOutcome } from './update-apply-client.js';
import { applyOutcomeCopy, applyStepsCopy } from './update-apply-copy.js';
import type { ServerObservation } from './update-status-queries.js';

export function UpdateNowButton({ status, onDone }: { status: ServerObservation | undefined; onDone: () => void }) {
  const toast = useToast();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const copy = outcome && applyOutcomeCopy(outcome);
  const steps = outcome && 'steps' in outcome ? outcome.steps : undefined;
  const enabled = !!status && !('kind' in status) && status.canFastForward
    && status.behind !== null && status.behind > 0 && status.dirty !== true;

  async function update() {
    if (!enabled || inFlight.current || !window.confirm('Update Phantom to the newest commit now?')) return;
    inFlight.current = true;
    setPending(true);
    setOutcome(null);
    try {
      const next = await applySelfUpdate();
      setOutcome(next);
      const message = applyOutcomeCopy(next);
      toast.show(message.text, message.tone === 'ok' ? 'success' : message.tone === 'danger' ? 'danger' : 'neutral');
    } finally {
      inFlight.current = false;
      setPending(false);
      onDone();
    }
  }

  return <div className={styles.root}>
    <Button size="sm" disabled={!enabled} busy={pending}
      icon={pending ? <span className={spinner.spinner} aria-hidden="true" /> : undefined}
      onClick={() => void update()}>
      {pending ? 'Updating…' : 'Update now'}
    </Button>
    <div className={styles.result} aria-live="polite" data-tone={copy?.tone}>{copy?.text}</div>
    {!!steps?.length && <ol className={styles.steps} aria-label="Update steps">
      {applyStepsCopy(steps).map((step, index) => <li key={index}>
        {step.label} · {step.status} · {step.duration}
        {step.status === 'failed' && steps[index]?.note && <div className={styles.note}>{steps[index].note}</div>}
      </li>)}
    </ol>}
  </div>;
}
