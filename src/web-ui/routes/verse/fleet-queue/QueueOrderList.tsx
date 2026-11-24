import { useRef, useState } from 'react';
import { queueAgeText, type QueueOrderAction, type QueueOrderV1 } from '../../../../core/queue/order-types.js';
import { Button } from '../../../components/primitives/index.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { postQueueAction } from './queue-order-action.js';
import styles from './fleet-queue.module.css';

interface Props {
  order: QueueOrderV1;
  onOpenJob: (id: string) => void;
  /** Called after an action so the caller reads the queue again. */
  onChanged: () => void | Promise<unknown>;
}

/** The queue in launch order. Each row can go to the top, to another lane, or out of the queue. */
export function QueueOrderList({ order, onOpenJob, onChanged }: Props) {
  // One row at a time shows its lane picker or its drop question.
  const [asking, setAsking] = useState<{ id: string; what: 'lane' | 'drop' } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const posting = useRef(false);

  async function act(action: QueueOrderAction, id: string, lane?: string) {
    if (posting.current) return;
    posting.current = true; setPending(true); setMessage('');
    try {
      setMessage((await postQueueAction(action, id, lane)).message);
      setAsking(null);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error && !(error instanceof ApiError) ? error.message : readFailureReason(error));
    } finally { posting.current = false; setPending(false); }
  }

  return <section aria-label="Launch order"><h3 className={styles.heading}>Launch order</h3>
    {message && <p className={styles.notice} role="status">{message}</p>}
    {order.jobs.length === 0 ? <p className={styles.message}>No queued jobs.</p> : <ol className={styles.list}>{order.jobs.map(job => {
      const ask = asking?.id === job.id ? asking.what : null;
      return <li className={styles.orderRow} key={`${job.id}:${job.position}`} data-superseded={job.supersededBy ? 'true' : undefined}>
        <span className={styles.orderText}>
          {job.position}. <JobRefs text={job.id} onOpenJob={onOpenJob} /> · {job.repo} · {job.lane} · {job.tier} · {queueAgeText(job.ageSeconds)}
          {job.supersededBy && <span className={styles.muted}> · replaced by {job.supersededBy}</span>}
        </span>
        <span className={styles.orderActions}>
          {ask === 'drop' ? <>
            <span>Drop {job.id}?</span>
            <Button size="sm" disabled={pending} onClick={() => void act('drop', job.id)}>Drop it</Button>
            <Button size="sm" disabled={pending} onClick={() => setAsking(null)}>Keep</Button>
          </> : ask === 'lane' ? <>
            <select aria-label={`New lane for ${job.id}`} disabled={pending} value="" onChange={event => { if (event.target.value) void act('lane', job.id, event.target.value); }}>
              <option value="">Move to…</option>{order.lanes.filter(lane => lane !== job.lane).map(lane => <option key={lane} value={lane}>{lane}</option>)}
            </select>
            <Button size="sm" disabled={pending} onClick={() => setAsking(null)}>Cancel</Button>
          </> : <>
            <Button size="sm" disabled={pending || job.position === 1} aria-label={`Move ${job.id} to the top`} onClick={() => void act('top', job.id)}>Top</Button>
            <Button size="sm" disabled={pending} aria-label={`Change lane for ${job.id}`} onClick={() => setAsking({ id: job.id, what: 'lane' })}>Lane</Button>
            <Button size="sm" disabled={pending} aria-label={`Drop ${job.id}`} onClick={() => setAsking({ id: job.id, what: 'drop' })}>Drop</Button>
          </>}
        </span>
      </li>;
    })}</ol>}
  </section>;
}
