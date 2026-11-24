/**
 * Pause, resume, stop or move a session's job from its conversation, so steering
 * does not mean leaving for the worker log. Each button makes the same call as
 * `phm job <action>` (POST /api/verse/fleet/runs/control) and the receipt is said
 * in the row; the request then shows in the conversation as a record line once
 * the next read carries the control file's own row. Stop asks first. Resume
 * replaces Pause while a pause stands. The lanes for Move are read only once
 * Move is opened. Nothing is drawn for a session with no job to steer.
 */
import { useEffect, useRef, useState } from 'react';
import { jobControlRecordLabel, jobControlText, type JobControlAction } from '../../../../core/fleet/job-control-types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { hasMutationHold } from '../../../data/auth-store.js';
import { useQuery } from '../../../data/hooks.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { postJobControl } from '../fleet-job-log/job-control-action.js';
import { stopFailureText } from '../fleet-job-log/job-stop-action.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { steerable, type SessionThread } from './session-thread-model.js';
import styles from './session-thread.module.css';

interface Ask { action: JobControlAction; lane?: string }
type Said = { tone: 'done' | 'waiting' | 'refused'; text: string };

export function ThreadControls({ thread, onDone }: { thread: SessionThread; onDone: () => void }) {
  const job = steerable(thread);
  const [busy, setBusy] = useState<JobControlAction | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [moving, setMoving] = useState(false);
  const [locked, setLocked] = useState<Ask | null>(null);
  const inFlight = useRef(false);
  const lanes = useQuery(opsRunsQuery, { enabled: moving && job !== null });
  const picker = useRef<HTMLSelectElement>(null);
  const listed = moving && lanes.data != null;
  useEffect(() => { setSaid(null); setConfirmStop(false); setMoving(false); setLocked(null); }, [job]);
  // The lane list takes the place of the button just pressed, so it takes the keyboard too.
  useEffect(() => { if (listed) picker.current?.focus(); }, [listed]);
  if (job === null) return null;

  const send = async (ask: Ask) => {
    if (inFlight.current) return;
    if (!hasMutationHold()) { setLocked(ask); return; }
    inFlight.current = true;
    setBusy(ask.action);
    setSaid(null);
    try {
      const receipt = await postJobControl(job, ask.action, ask.lane);
      const landed = receipt.status === 'applied' || receipt.status === 'requested';
      setSaid({ tone: receipt.status === 'applied' ? 'done' : landed ? 'waiting' : 'refused', text: jobControlText(receipt) });
      if (landed) { setMoving(false); onDone(); }
    } catch (error) {
      setSaid({ tone: 'refused', text: stopFailureText(error) });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  const stands = thread.control;
  const paused = stands?.action === 'pause';
  const rows = lanes.data?.lanes.filter(row => row.lane !== thread.session.lane) ?? null;
  return <div className={styles.controls} role="group" aria-label={`Steer ${job}`}>
    {/* A finished resume, stop or move is history, and the conversation holds it; the chip is for what is pending or still in force. */}
    {stands && (stands.status === 'requested' || paused) && <span className={styles.standing} data-status={stands.status}>{jobControlRecordLabel(stands)}</span>}
    {paused
      ? <button type="button" className={styles.link} disabled={busy !== null} onClick={() => void send({ action: 'resume' })}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
      : <button type="button" className={styles.link} disabled={busy !== null} onClick={() => void send({ action: 'pause' })}>{busy === 'pause' ? 'Pausing…' : 'Pause'}</button>}
    <button type="button" className={styles.link} data-danger disabled={busy !== null} onClick={() => { setSaid(null); setConfirmStop(true); }}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
    {!moving ? <button type="button" className={styles.link} disabled={busy !== null} onClick={() => setMoving(true)}>Move…</button>
      : rows === null ? <span className={styles.muted} role="status">{lanes.error || lanes.data === null ? 'Lanes unknown: the fleet read did not answer.' : 'Reading lanes…'}
        {(lanes.error || lanes.data === null) && <> <button type="button" className={styles.link} onClick={() => setMoving(false)}>Close</button></>}</span>
      : <select ref={picker} className={styles.move} aria-label={`Move ${job} to another lane`} value="" disabled={busy !== null}
        onChange={event => { if (event.target.value) void send({ action: 'move', lane: event.target.value }); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMoving(false); } }}>
        <option value="">Move to…</option>
        {rows.map(row => {
          const blocked = row.held ? 'held' : row.running >= row.target ? 'full' : null;
          return <option key={row.lane} value={row.lane} disabled={blocked !== null}>{row.lane}{blocked ? ` (${blocked})` : ''}</option>;
        })}
      </select>}
    {said && <span className={styles.said} data-tone={said.tone} role="status">{said.text}</span>}
    <ConfirmDialog open={confirmStop} onClose={() => setConfirmStop(false)} title={`Stop ${job}?`}
      body="This stops the job’s running processes." confirmLabel="Yes, stop" destructive busy={busy === 'stop'}
      onConfirm={() => { setConfirmStop(false); void send({ action: 'stop' }); }} />
    <MutationTokenDialog open={locked !== null} onClose={() => setLocked(null)} onUnlocked={() => { const ask = locked; setLocked(null); if (ask) void send(ask); }}
      reason="Steering a session requires the mutation token." tokenHelp="the mutation token ashlr verse printed" />
  </div>;
}
