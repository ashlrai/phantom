import { useState } from 'react';
import { jobControlText, type JobControlAction } from '../../../../../core/fleet/job-control-types.js';
import { useQuery } from '../../../../data/hooks.js';
import { postJobControl } from '../../fleet-job-log/job-control-action.js';
import { opsRunsQuery } from '../../ops/ops-runs-queries.js';
import { runMobileAction } from '../mobile-actions.js';
import { showMobileToast } from '../mobile-toast.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { Button } from '../ui.js';
import { Section, ui } from '../ui-parts.js';

const ASK: Record<JobControlAction, { title: string; says: string }> = {
  pause: { title: 'Pause', says: 'Asks the dispatcher to pause this job.' },
  resume: { title: 'Resume', says: 'Asks the dispatcher to resume this job.' },
  stop: { title: 'Stop', says: 'This stops the job’s running processes.' },
  move: { title: 'Move', says: 'Moves this job to the lane you picked.' },
};

/**
 * Pause, Resume, Stop and Move for one job on the phone worker screen. The
 * same call as the desktop (postJobControl → POST runs/control, the typed
 * receipt `phm jobs <action>` prints). Only Stop asks first, with one confirm
 * tap; the answer comes back as a toast in plain words.
 */
export function WorkerControls({ job, lane }: { job: string; lane: string | null | undefined }) {
  const { permissions } = useMobile();
  // Lanes are read only once the Move picker is touched: a worker screen that is just read costs no extra request.
  const [picking, setPicking] = useState(false);
  const lanes = useQuery(opsRunsQuery, { enabled: picking }).data?.lanes ?? [];
  if (!canShowActions(permissions)) return null;
  const send = (action: JobControlAction, to?: string) => {
    const ask = ASK[action];
    let said = '';
    runMobileAction({
      title: `${ask.title} ${job}?`, consequences: ask.says, confirmLabel: action === 'stop' ? 'Yes, stop' : ask.title,
      destructive: action === 'stop', confirm: action === 'stop',
      run: async () => {
        const receipt = await postJobControl(job, action, to);
        said = jobControlText(receipt);
        if (receipt.status === 'refused' || receipt.status === 'unknown') throw new Error(said);
      },
      onDone: () => showMobileToast(said, 'success'),
    });
  };
  return <Section title="Control this job" flat>
    <div className={ui.buttonRow}>
      <Button variant="tinted" aria-label="Pause this job" onClick={() => send('pause')}>Pause</Button>
      <Button variant="tinted" aria-label="Resume this job" onClick={() => send('resume')}>Resume</Button>
      <Button variant="tinted" aria-label="Stop this job" onClick={() => send('stop')}>Stop</Button>
    </div>
    <select aria-label="Move this job to another lane" value="" onFocus={() => setPicking(true)} onPointerDown={() => setPicking(true)} onChange={(event) => { if (event.target.value) send('move', event.target.value); }}>
      <option value="">Move to…</option>
      {lanes.filter((row) => row.lane !== lane).map((row) => {
        const blocked = row.held ? 'held' : row.running >= row.target ? 'full' : null;
        return <option key={row.lane} value={row.lane} disabled={blocked !== null}>{row.lane}{blocked ? ` (${blocked})` : ''}</option>;
      })}
    </select>
  </Section>;
}
