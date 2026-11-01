import { useState } from 'react';
import { getMutationToken, touchMutationHold } from '../../../../data/auth-store.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { VerseControlLockedError } from '../../autonomy/control-queries.js';
import { useGuardState } from '../../shell/guard-store.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { Button, Screen } from '../ui.js';
import { ui } from '../ui-parts.js';
import { DROP_JOB_LANES, DROP_JOB_TIERS, DROP_JOB_MAX_FILE_BYTES, dropJobHeader, dropJobBytes, suggestId, validateDropJob } from './drop-job-model.js';
import styles from './DropJobScreen.module.css';

const path = '/api/verse/fleet/live/drop-jobs';
const denied = "This phone's gateway does not allow drop-jobs yet; it is being added";
export function DropJobScreen() {
  const { permissions, reachability, navigate } = useMobile();
  const guard = useGuardState();
  const [id, setId] = useState('');
  const [editedId, setEditedId] = useState(false);
  const [lane, setLane] = useState('codex-personal');
  const [tier, setTier] = useState('mid');
  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState('');
  const header = dropJobHeader(lane, tier);
  const payload = { id, lane, tier, body: `${header}\n\n${goal}` };
  const verdict = validateDropJob(payload);
  const busy = guard.request !== null;
  const submit = () => {
    if (!verdict.ok || !goal.trim() || busy) return;
    runMobileAction({
      title: 'Hand the fleet a job',
      consequences: 'Writes a job for the fleet to ingest.',
      confirmLabel: 'Hand to the fleet',
      confirm: false,
      run: async () => {
        const token = getMutationToken();
        if (!token) throw new VerseControlLockedError();
        setMessage('');
        setReceipt('');
        try {
          let raw: Record<string, unknown>;
          if (isRemoteMobileMode()) {
            raw = await (await import('../../../../data/remote-session.js')).remoteMutate('POST', path, payload) as Record<string, unknown>;
          } else {
            const res = await fetch(path, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
              body: JSON.stringify(payload),
            });
            raw = await res.json() as Record<string, unknown>;
            if (!res.ok) { setMessage(refusal(raw)); return; }
          }
          if (raw.status !== 'written' || typeof raw.bytes !== 'number') { setMessage(refusal(raw)); return; }
          touchMutationHold();
          setReceipt(`Written RQ-PHX-${payload.id}.md · ${raw.bytes} B · ingest sweeps about every 2 min`);
          setId('');
          setEditedId(false);
          setGoal('');
        } catch (error) {
          const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
          if (isRemoteMobileMode() && (status === 403 || status === 404)) setMessage(denied);
          else if (error && typeof error === 'object' && 'detail' in error && typeof error.detail === 'string') setMessage(error.detail);
          else setMessage(error instanceof Error ? error.message : 'The job could not be written.');
        }
      },
    });
  };
  return <Screen title="Hand the fleet a job" onBack={() => navigate({ screen: 'more' })} backLabel="More" label="Hand the fleet a job">
    <form className={styles.form} onSubmit={event => { event.preventDefault(); submit(); }}>
      <fieldset disabled={busy} className={styles.fields}>
        <label>Job id<input value={id} onChange={event => { setId(event.target.value); setEditedId(true); }} /></label>
        <div role="group" aria-label="Lane" className={ui.chips}>{DROP_JOB_LANES.map(value => <button className={ui.chip} type="button" key={value} aria-pressed={lane === value} onClick={() => setLane(value)}>{value}</button>)}</div>
        <div role="group" aria-label="Tier" className={ui.chips}>{DROP_JOB_TIERS.map(value => <button className={ui.chip} type="button" key={value} aria-pressed={tier === value} onClick={() => setTier(value)}>{value}</button>)}</div>
        <code className={styles.header}>{header}</code>
        <label>Goal<textarea rows={9} value={goal} onChange={event => { setGoal(event.target.value); if (!editedId) setId(suggestId(event.target.value, Date.now())); }} /></label>
        <p>{dropJobBytes(payload)} / {DROP_JOB_MAX_FILE_BYTES} B</p>
        {!verdict.ok && goal ? <p role="alert">{verdict.reason}</p> : null}
        <Button type="submit" variant="primary" block disabled={!verdict.ok || !goal.trim() || !canShowActions(permissions) || reachability === 'offline' || reachability === 'unreachable'}>Hand to the fleet</Button>
      </fieldset>
      {message ? <p role="alert">{message}</p> : null}
      {receipt ? <p role="status">{receipt}</p> : null}
    </form>
  </Screen>;
}
function refusal(raw: Record<string, unknown>): string {
  if (typeof raw.reason === 'string') return raw.reason;
  if (Array.isArray(raw.reasons)) return raw.reasons.join('; ');
  if (typeof raw.error === 'string') return raw.error;
  return typeof raw.status === 'string' ? raw.status : 'The job could not be written.';
}
