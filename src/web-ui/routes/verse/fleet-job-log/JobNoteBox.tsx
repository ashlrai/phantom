import { useMemo, useRef, useState } from 'react';
import { jobNotesLines, jobSayText } from '../../../../core/fleet/job-notes-types.js';
import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { JOB_NOTE_MAX, jobNotesQuery, postJobSay } from './job-note-action.js';
import { stopFailureText } from './job-stop-action.js';

/**
 * Say something to one job and see what was said: a note box, then "Notes
 * sent". The same call as `phm job say` (postJobSay → runs/notes). The box is
 * only offered while the job can still read a note (`open`); the notes already
 * sent stay listed once it has finished.
 */
export function JobNoteBox({ job, open, enabled = true }: { job: string; open: boolean; enabled?: boolean }) {
  const def = useMemo(() => jobNotesQuery(job), [job]);
  const notes = useQuery(def, { enabled }).data?.notes ?? [];
  const refetch = useRefresh(def);
  const inFlight = useRef(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [lastJob, setLastJob] = useState(job);
  if (lastJob !== job) { setLastJob(job); setDraft(''); setSaid(''); }
  const send = async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const receipt = await postJobSay(job, text);
      setSaid(jobSayText(receipt));
      if (receipt.status === 'sent') { setDraft(''); refetch(); }
    } catch (error) {
      setSaid(stopFailureText(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (!open && notes.length === 0) return null;
  const lines = jobNotesLines(notes);
  return <section aria-label="Notes to this job">
    {open && <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <label>Tell this job <input aria-label="Note to this job" value={draft} maxLength={JOB_NOTE_MAX} placeholder="e.g. also update the docs" disabled={busy} onChange={event => setDraft(event.target.value)} /></label>
      <Button size="sm" variant="subtle" type="submit" aria-label="Send note to this job" disabled={busy || draft.trim() === ''}>Send note</Button>
      {said !== '' && <span role="status">{said}</span>}
    </form>}
    {lines.length > 0 && <>
      <h4>Notes sent</h4>
      <ul aria-label="Notes sent">{lines.map((line, i) => <li key={notes[i]!.id}>{line}</li>)}</ul>
    </>}
  </section>;
}
