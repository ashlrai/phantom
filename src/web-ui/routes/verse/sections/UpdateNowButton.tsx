import { useRef, useState } from 'react';
import styles from './UpdateNowButton.module.css';
import spinner from '../../../components/primitives/RefreshIndicator.module.css';
import { Button } from '../../../components/primitives/Button.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { applySelfUpdate } from './update-apply-client.js';
import { applyOutcomeCopy } from './update-apply-copy.js';
import type { ServerObservation } from './update-status-queries.js';

export function UpdateNowButton({ status, onDone }: { status: ServerObservation | undefined; onDone: () => void }) {
  const toast = useToast();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [copy, setCopy] = useState<ReturnType<typeof applyOutcomeCopy> | null>(null);
  const enabled = !!status && !('kind' in status) && status.canFastForward
    && status.behind !== null && status.behind > 0 && status.dirty !== true;

  async function update() {
    if (!enabled || inFlight.current || !window.confirm('Update Phantom to the newest commit now?')) return;
    inFlight.current = true;
    setPending(true);
    setCopy(null);
    try {
      const next = applyOutcomeCopy(await applySelfUpdate());
      setCopy(next);
      toast.show(next.text, next.tone === 'ok' ? 'success' : next.tone === 'danger' ? 'danger' : 'neutral');
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
  </div>;
}
