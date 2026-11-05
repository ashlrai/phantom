import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { approveCosTask, cosTaskLine, isCosRouteAbsent, readCosTask, reconcileCosTask, type CosReconcileVerdict, type CosStatus } from './cos-task-client.js';

export const COS_LAST_KEY = 'phantom.cosTask.last';
const POLL_MS = 15_000;

export function rememberCosTask(id: string): void {
  try { window.localStorage.setItem(COS_LAST_KEY, id); } catch { /* Storage can be unavailable. */ }
}
export function lastCosTask(): string | null {
  try { return window.localStorage.getItem(COS_LAST_KEY); } catch { return null; }
}

export function CosTaskCard({ id }: { id: string }) {
  const [status, setStatus] = useState<CosStatus | null>(null);
  const [note, setNote] = useState('');
  const [approving, setApproving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  // A reconcile attempt that found a fresh 'sending' claim: the reply may still be in flight.
  const [stillSending, setStillSending] = useState(false);
  const busy = useRef(false);
  const sent = status?.delivery === 'sent';
  useEffect(() => { rememberCosTask(id); setStatus(null); setNote(''); setStillSending(false); }, [id]);
  const refetch = useCallback(async () => {
    try { setStatus(await readCosTask(id)); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'COS_UNKNOWN') setNote('This task is no longer known.');
      else if (isCosRouteAbsent(error)) setNote('Tasks are not in this build yet');
    }
  }, [id]);
  useEffect(() => { void refetch(); }, [refetch]);
  usePollWhileVisible(() => { if (!sent) void refetch(); }, POLL_MS, { enabled: !sent });

  async function approve() {
    if (!status?.draft || busy.current) return;
    busy.current = true;
    setApproving(true);
    setNote('');
    try {
      await approveCosTask(id, status.draft.digest);
      setStatus({ ...status, delivery: 'sent' });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      if (code === 'COS_APPROVAL_STALE') { setNote('Draft changed; review the new text'); await refetch(); }
      else if (code === 'COS_ALREADY_CLAIMED') { setNote('Someone already approved this draft.'); await refetch(); }
      else if (code === 'COS_DELIVERY_UNCERTAIN') setStatus({ ...status, delivery: 'uncertain' });
      else if (code === 'COS_NO_TRANSPORT') setNote(`No way to send on ${status.channel} from here.`);
      else setNote(error instanceof ApiError ? error.detail ?? error.message : 'The approval could not be sent.');
    } finally {
      busy.current = false;
      setApproving(false);
    }
  }

  async function reconcile(verdict: CosReconcileVerdict) {
    if (busy.current) return;
    busy.current = true;
    setReconciling(true);
    setNote('');
    try {
      const result = await reconcileCosTask(id, verdict);
      setStillSending(false);
      if (result.delivery === 'sent') setStatus(status ? { ...status, delivery: 'sent' } : status);
      else await refetch(); // retry cleared the claim; the Approve button returns for one more approval
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null;
      if (code === 'COS_STILL_SENDING') { setStillSending(true); setNote('Still sending; try again in a few minutes'); }
      else if (code === 'COS_NOTHING_TO_RECONCILE') { setNote('Nothing to reconcile; the delivery has moved on.'); await refetch(); }
      else setNote(error instanceof ApiError ? error.detail ?? error.message : 'The answer could not be recorded.');
    } finally {
      busy.current = false;
      setReconciling(false);
    }
  }
  const canReconcile = status?.delivery === 'uncertain' || (status?.delivery === 'sending' && stillSending);

  return <section aria-label="Task">
    <p role="status" aria-live="polite">{cosTaskLine(status)}</p>
    {status?.draft && status.delivery === null ? <>
      <p>Reply for {status.channel}</p>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '16rem', overflow: 'auto' }}>{status.draft.text}</pre>
      <Button variant="primary" size="sm" disabled={approving} onClick={() => void approve()}>{approving ? 'Approving…' : 'Approve'}</Button>
    </> : null}
    {canReconcile ? <>
      <p>The send may not have arrived. Check {status?.channel}, then:</p>
      <Button variant="subtle" size="sm" disabled={reconciling} onClick={() => void reconcile('delivered')}>It arrived</Button>
      <Button variant="subtle" size="sm" disabled={reconciling} onClick={() => void reconcile('retry')}>Send again</Button>
    </> : null}
    {note ? <p role="alert">{note}</p> : null}
  </section>;
}
