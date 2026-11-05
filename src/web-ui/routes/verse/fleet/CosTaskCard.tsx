import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { approveCosTask, cosTaskLine, isCosRouteAbsent, readCosTask, type CosStatus } from './cos-task-client.js';

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
  const busy = useRef(false);
  const sent = status?.delivery === 'sent';
  useEffect(() => { rememberCosTask(id); setStatus(null); setNote(''); }, [id]);
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

  return <section aria-label="Task">
    <p role="status" aria-live="polite">{cosTaskLine(status)}</p>
    {status?.draft && status.delivery === null ? <>
      <p>Reply for {status.channel}</p>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '16rem', overflow: 'auto' }}>{status.draft.text}</pre>
      <Button variant="primary" size="sm" disabled={approving} onClick={() => void approve()}>{approving ? 'Approving…' : 'Approve'}</Button>
    </> : null}
    {note ? <p role="alert">{note}</p> : null}
  </section>;
}
