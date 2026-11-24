import { useId, useMemo, useState } from 'react';
import { jobNotesLines, jobSayText } from '../../../../../core/fleet/job-notes-types.js';
import { useQuery, useRefresh } from '../../../../data/hooks.js';
import { JOB_NOTE_MAX, jobNotesQuery, postJobSay } from '../../fleet-job-log/job-note-action.js';
import { runMobileAction } from '../mobile-actions.js';
import { showMobileToast } from '../mobile-toast.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { Button } from '../ui.js';
import { Section, ui } from '../ui-parts.js';

/**
 * Tell one job something from the phone worker screen, and list "Notes sent".
 * The same call as the desktop note box and `phm job say` (postJobSay → POST
 * runs/notes). One tap sends; the answer comes back as a toast in plain words.
 * With `open` false (the job has finished) only the notes already sent show.
 */
export function WorkerNote({ job, open }: { job: string; open: boolean }) {
  const { permissions } = useMobile();
  const def = useMemo(() => jobNotesQuery(job), [job]);
  const notes = useQuery(def).data?.notes ?? [];
  const refetch = useRefresh(def);
  const [draft, setDraft] = useState('');
  const boxId = useId();
  const canAct = open && canShowActions(permissions);
  if (!canAct && notes.length === 0) return null;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    let said = '';
    runMobileAction({
      title: `Tell ${job}`, consequences: 'Adds your note to this job. A worker reads it at its next step where it can.',
      confirmLabel: 'Send note', confirm: false,
      run: async () => {
        const receipt = await postJobSay(job, text);
        said = jobSayText(receipt);
        if (receipt.status !== 'sent') throw new Error(said);
      },
      onDone: () => { showMobileToast(said, 'success'); setDraft(current => current.trim() === text ? '' : current); refetch(); },
    });
  };
  const lines = jobNotesLines(notes);
  return <Section title="Tell this job" flat>
    {canAct && <div className={ui.card}>
      <div className={ui.field}>
        <label className={ui.label} htmlFor={boxId}>Your note</label>
        <textarea id={boxId} className={ui.textarea} value={draft} maxLength={JOB_NOTE_MAX} placeholder="e.g. also update the docs" onChange={(e) => setDraft(e.target.value)} />
      </div>
      <Button variant="tinted" aria-label="Send note to this job" disabled={draft.trim() === ''} onClick={send}>Send note</Button>
    </div>}
    {lines.length > 0 && <>
      <p className={ui.muted}>Notes sent</p>
      <ul aria-label="Notes sent">{lines.map((line, i) => <li key={notes[i]!.id}>{line}</li>)}</ul>
    </>}
  </Section>;
}
