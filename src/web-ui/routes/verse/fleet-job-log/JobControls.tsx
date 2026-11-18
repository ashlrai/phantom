import { useEffect, useRef, useState } from 'react';
import { jobControlText, type JobControlAction } from '../../../../core/fleet/job-control-types.js';
import { Button } from '../../../components/primitives/index.js';
import { useQuery } from '../../../data/hooks.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { postJobControl } from './job-control-action.js';
import { stopFailureText } from './job-stop-action.js';

/**
 * Pause, Resume, Stop and Move for one job, with the receipt shown inline:
 * the same controls in the job detail sheet and the Worker log pane. Only
 * Stop asks first. Choosing a lane moves at once; held and full lanes are
 * listed but cannot be chosen (the server refuses them as well). With a
 * `disabledReason` every control is shown disabled and the reason is said.
 */
export function JobControls({ job, lane, onDone, disabledReason }: { job: string; lane: string | null | undefined; onDone: () => void; disabledReason?: string | null }) {
  const lanes = useQuery(opsRunsQuery).data?.lanes ?? [];
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [text, setText] = useState('');
  const off = busy || !!disabledReason;
  useEffect(() => { setConfirmStop(false); setText(''); }, [job]);
  const send = async (action: JobControlAction, to?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const receipt = await postJobControl(job, action, to);
      setText(jobControlText(receipt));
      if (receipt.status === 'applied' || receipt.status === 'requested') onDone();
    } catch (error) {
      setText(stopFailureText(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return <>
    <Button size="sm" variant="subtle" aria-label="Pause this job" disabled={off} onClick={() => void send('pause')}>Pause</Button>
    <Button size="sm" variant="subtle" aria-label="Resume this job" disabled={off} onClick={() => void send('resume')}>Resume</Button>
    <Button size="sm" variant="subtle" aria-label="Stop this job" disabled={off} onClick={() => { setText(''); setConfirmStop(true); }}>Stop</Button>
    <select aria-label="Move this job to another lane" value="" disabled={off} onChange={event => { if (event.target.value) void send('move', event.target.value); }}>
      <option value="">Move to…</option>
      {lanes.filter(row => row.lane !== lane).map(row => {
        const blocked = row.held ? 'held' : row.running >= row.target ? 'full' : null;
        return <option key={row.lane} value={row.lane} disabled={blocked !== null}>{row.lane}{blocked ? ` (${blocked})` : ''}</option>;
      })}
    </select>
    {disabledReason && <span role="note">{disabledReason}</span>}
    {text !== '' && <span role="status">{text}</span>}
    <ConfirmDialog open={confirmStop} onClose={() => setConfirmStop(false)} title={`Stop ${job}?`}
      body="This stops the job’s running processes." confirmLabel="Yes, stop" destructive busy={busy}
      onConfirm={() => { setConfirmStop(false); void send('stop'); }} />
  </>;
}
