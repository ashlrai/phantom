import { useRef, useState } from 'react';
import styles from './UpdateNowButton.module.css';
import spinner from '../../../components/primitives/RefreshIndicator.module.css';
import { Button } from '../../../components/primitives/Button.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { useQuery } from '../../../data/hooks.js';
import { fleetLiveQuery } from '../command/surface-data.js';
import { applySelfUpdate, type ApplyOutcome } from './update-apply-client.js';
import { applyOutcomeCopy, applyStepsCopy } from './update-apply-copy.js';
import type { ServerObservation } from './update-status-queries.js';

/**
 * What Mason reads before he clicks: fleet runs are host processes launched
 * by dispatchd in separate sessions, so the self-update (git fast-forward +
 * rebuild + sidecar restart) never stops, pauses or drains them. The count is
 * `summary.building` from the Fleet section's own live read — "runs producing
 * / verifying / judging / landing right now" — shared through the query cache,
 * not a new endpoint. Unknown count still gets the claim, without a number.
 */
function fleetKeepNote(building: number | null): string {
  if (building === null) return 'Fleet jobs keep running';
  if (building === 0) return 'No fleet jobs running';
  return `${building} fleet job${building === 1 ? '' : 's'} keep${building === 1 ? 's' : ''} running during the update`;
}

export function UpdateNowButton({ status, onDone }: { status: ServerObservation | undefined; onDone: () => void }) {
  const toast = useToast();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const copy = outcome && applyOutcomeCopy(outcome);
  const steps = outcome && 'steps' in outcome ? outcome.steps : undefined;
  const fleet = useQuery(fleetLiveQuery, { freshMs: 60_000 });
  const building = fleet.data?.value?.summary.building;
  const runningJobs = typeof building === 'number' && Number.isFinite(building) && building >= 0 ? Math.floor(building) : null;
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
    <div className={styles.actionRow}>
      <Button size="sm" disabled={!enabled} busy={pending}
        icon={pending ? <span className={spinner.spinner} aria-hidden="true" /> : undefined}
        onClick={() => void update()}>
        {pending ? 'Updating…' : 'Update now'}
      </Button>
      <span className={styles.keepNote} aria-live="polite">{fleetKeepNote(runningJobs)}</span>
    </div>
    <div className={styles.result} aria-live="polite" data-tone={copy?.tone}>{copy?.text}</div>
    {!!steps?.length && <ol className={styles.steps} aria-label="Update steps">
      {applyStepsCopy(steps).map((step, index) => <li key={index}>
        {step.label} · {step.status} · {step.duration}
        {step.status === 'failed' && steps[index]?.note && <div className={styles.note}>{steps[index].note}</div>}
      </li>)}
    </ol>}
  </div>;
}
