import { useRef, useState } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { tiers } from './drop-job-model.js';
import { moveOutcomeText, postQueueMove } from './queue-move-action.js';

interface Props {
  fromLane: string;
  lanes: readonly { lane: string }[];
  heldLanes: readonly string[];
  onMoved: () => void | Promise<unknown>;
}
export function QueueMoveControl({ fromLane, lanes, heldLanes, onMoved }: Props) {
  const [open, setOpen] = useState(false);
  const [lane, setLane] = useState('');
  const [tier, setTier] = useState('');
  const [pending, setPending] = useState(false);
  const posting = useRef(false);
  const [message, setMessage] = useState('');
  const targets = lanes.filter(row => row.lane !== fromLane && !heldLanes.includes(row.lane));
  const valid = targets.some(row => row.lane === lane);
  async function move() {
    if (posting.current || !valid) return;
    posting.current = true; setPending(true); setMessage('');
    try {
      const report = await postQueueMove(fromLane, lane, tier || undefined);
      setMessage(moveOutcomeText(report));
      await onMoved();
    } catch (error) {
      setMessage(error instanceof Error && !(error instanceof ApiError) ? error.message : readFailureReason(error));
    } finally { posting.current = false; setPending(false); }
  }
  return <span>
    <Button size="sm" disabled={pending} aria-expanded={open} onClick={() => setOpen(!open)}>Move Phantom jobs to…</Button>
    {open && <>
      <select aria-label={`Target lane for ${fromLane}`} disabled={pending} value={valid ? lane : ''} onChange={event => setLane(event.target.value)}>
        <option value="">Choose lane</option>{targets.map(row => <option key={row.lane} value={row.lane}>{row.lane}</option>)}
      </select>
      <select aria-label={`Tier for ${fromLane}`} disabled={pending} value={tier} onChange={event => setTier(event.target.value)}>
        <option value="">keep tier</option>{tiers.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <Button size="sm" disabled={pending || !valid} onClick={() => void move()}>Confirm move</Button>
    </>}
    {message && <span role="status">{message}</span>}
  </span>;
}
