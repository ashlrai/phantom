import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { getQuerySnapshot, refetchQuery, subscribeQuery } from '../../../data/cache.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { laneTargetsQuery, postLaneTarget } from '../ops/lane-targets-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { laneWriting, setLaneWriting, subscribeLaneWrite } from './LaneTargetStepper.js';
import { LANE_PAUSE_KEY, parsePauseRecord, pauseLabel, pauseTransition, resumeTransition } from './lane-pause-model.js';
import styles from './fleet-lanes.module.css';

function readRecord() {
  try { return parsePauseRecord(localStorage.getItem(LANE_PAUSE_KEY)); } catch { return {}; }
}

export function LanePauseButton({ lane }: { lane: string }) {
  const read = useSyncExternalStore(
    listener => subscribeQuery(laneTargetsQuery.key, listener),
    () => getQuerySnapshot<LaneTargetsV1 | null>(laneTargetsQuery.key),
  );
  const hold = useMutationHold();
  const pending = useSyncExternalStore(subscribeLaneWrite, laneWriting, () => false);
  const [record, setRecord] = useState(readRecord);
  const [postedTarget, setPostedTarget] = useState<number | null>(null);
  const [error, setError] = useState('');
  const row = read.data?.lanes.find(item => item.lane === lane);
  const target = postedTarget ?? row?.target;
  const paused = target === 0;

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === LANE_PAUSE_KEY || event.key === null) setRecord(readRecord()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  async function change() {
    if (!row || !hold.hasHold || laneWriting()) return;
    const remembered = readRecord();
    const transition = paused ? resumeTransition(lane, remembered, row.floor, row.pausedFrom) : pauseTransition(lane, row.target, remembered);
    setError('');
    // Refuse to pause when the previous target cannot be saved for later.
    try { if (!paused) localStorage.setItem(LANE_PAUSE_KEY, JSON.stringify(remembered)); }
    catch { setError('Could not save the remembered target on this device.'); return; }
    setLaneWriting(true);
    try {
      const response = await postLaneTarget(lane, transition.target);
      setPostedTarget(response.lanes.find(item => item.lane === lane)?.target ?? transition.target);
      try { localStorage.setItem(LANE_PAUSE_KEY, JSON.stringify(transition.record)); setRecord(transition.record); }
      catch { setRecord(transition.record); setError('Could not save the remembered target on this device.'); }
      await Promise.all([
        refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true),
        refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true),
      ]);
      if (getQuerySnapshot(laneTargetsQuery.key).status === 'success') setPostedTarget(null);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code === 'out-of-range' && !paused && row.floor > 0
        ? `Floor is ${row.floor}; set the target instead.`
        : reason instanceof ApiError && reason.status === 409 && !reason.detail
          ? 'Another fleet control action is running, try again in a moment.' : readFailureReason(reason));
    } finally { setLaneWriting(false); }
  }

  return <>
    {paused && pauseLabel(lane, record, row?.pausedFrom) ? <span className={styles.badge}>{pauseLabel(lane, record, row?.pausedFrom)}</span> : null}
    <Button size="sm" aria-label={`${paused ? 'Resume' : 'Pause'} ${lane}`} disabled={!row || !hold.hasHold || pending} onClick={() => void change()}>{paused ? 'Resume' : 'Pause'}</Button>
    {error ? <span className={styles.pauseError} role="status">{error}</span> : null}
  </>;
}
