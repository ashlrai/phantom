import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { getQuerySnapshot, refetchQuery } from '../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { captionFor, stepAllowed, type LaneTargetRow, type LaneTargetsV1 } from './lane-targets-model.js';
import { laneTargetsQuery, postLaneTarget } from './lane-targets-queries.js';
import { opsRunsQuery } from './ops-runs-queries.js';
import styles from './ops.module.css';
import targets from './lane-targets.module.css';

export function LaneTargets() {
  const read = useQuery(laneTargetsQuery);
  const refetch = useRefetch(laneTargetsQuery);
  const hold = useMutationHold();
  const [posted, setPosted] = useState<LaneTargetsV1 | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ lane: string; message: string } | null>(null);
  const [confirm, setConfirm] = useState<{ lane: string; until: number } | null>(null);
  const writing = useRef(false);
  const active = useRef(true);
  const data = posted ?? read.data;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (posted && !pending && read.status === 'success') setPosted(null);
  }, [posted, pending, read.status]);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(null), Math.max(0, confirm.until - Date.now()));
    return () => clearTimeout(timer);
  }, [confirm]);
  usePollWhileVisible(() => { if (!writing.current) refetch(); }, 10_000, { enabled: data !== null });

  async function change(row: LaneTargetRow, delta: -1 | 1): Promise<void> {
    if (writing.current || !hold.hasHold || !stepAllowed(row, delta)) return;
    const target = row.target + delta;
    if (delta === -1 && target === 0 && (!confirm || confirm.lane !== row.lane || Date.now() >= confirm.until)) {
      setConfirm({ lane: row.lane, until: Date.now() + 5_000 });
      return;
    }
    setConfirm(null);
    writing.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await postLaneTarget(row.lane, target);
      if (active.current) setPosted(response);
      await Promise.all([
        refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true),
        refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true),
      ]);
      if (active.current && getQuerySnapshot(laneTargetsQuery.key).status === 'success') setPosted(null);
    } catch (reason) {
      const message = reason instanceof ApiError && reason.status === 409
        ? 'Another fleet control action is running, try again in a moment.' : readFailureReason(reason);
      if (active.current) setError({ lane: row.lane, message });
    } finally {
      writing.current = false;
      if (active.current) setPending(false);
    }
  }

  return <div className={targets.root}>
    <h3 className={styles.groupTitle}>Lane targets</h3>
    {data === null ? <p className={styles.empty}>Lane targets are not available in this build yet.</p>
      : !data ? <p className={styles.empty} role="status">{read.status === 'error' ? 'Lane targets are unavailable.' : 'Reading lane targets…'}</p>
      : <>
        {!hold.hasHold ? <p className={styles.note}>Unlock the mutation hold to change lane targets.</p> : null}
        {data.sourceState === 'missing' ? <p className={styles.empty}>No lane target state is available on this Mac.</p> : null}
        {data.sourceState === 'degraded' ? <p className={styles.note} role="status">Lane targets may be incomplete; the source is degraded.</p> : null}
        {data.lanes.map(row => {
          const confirming = confirm?.lane === row.lane && row.target === 1;
          const caption = captionFor(row, Date.now());
          return <div key={row.lane} className={targets.row}>
            <div className={targets.controls}>
              <strong>{row.lane}</strong>
              <span className={targets.readout}>{row.floor} ≤ {row.target} ≤ {row.ceiling}</span>
              <Button size="sm" aria-label={confirming ? `Confirm 0 for ${row.lane}` : `Lower ${row.lane} target to ${row.target - 1}`} disabled={!hold.hasHold || pending || !stepAllowed(row, -1)} onClick={() => void change(row, -1)}>{confirming ? 'Confirm 0' : '−'}</Button>
              <Button size="sm" aria-label={`Raise ${row.lane} target to ${row.target + 1}`} disabled={!hold.hasHold || pending || !stepAllowed(row, 1)} onClick={() => void change(row, 1)}>+</Button>
              {row.held ? <span className={styles.chip} data-tone="bad" title={row.heldReason ?? undefined}>Held</span> : null}
            </div>
            {caption ? <p className={styles.note}>{caption}</p> : null}
            {error?.lane === row.lane ? <p className={styles.note} role="status">{error.message}</p> : null}
          </div>;
        })}
        {read.status === 'error' ? <p className={styles.note} role="status">Lane targets could not refresh. Showing the last reading.</p> : null}
      </>}
  </div>;
}
