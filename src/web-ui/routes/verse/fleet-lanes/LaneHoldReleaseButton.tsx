import { useState, useSyncExternalStore } from 'react';
import { Button } from '../../../components/primitives/index.js';
import { getQuerySnapshot, refetchQuery, subscribeQuery } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { useMutationHold } from '../../../data/hooks.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { laneWriting, setLaneWriting, subscribeLaneWrite } from './LaneTargetStepper.js';
import { holdKind, postReleaseHold, releaseLabel } from './lane-hold-release.js';
import styles from './fleet-lanes.module.css';

export function LaneHoldReleaseButton({ lane, heldReason, heldUntil }: { lane: string; heldReason: string | null; heldUntil: string | null }) {
  const targets = useSyncExternalStore(
    listener => subscribeQuery(laneTargetsQuery.key, listener),
    () => getQuerySnapshot<LaneTargetsV1 | null>(laneTargetsQuery.key),
  );
  const hold = useMutationHold();
  const pending = useSyncExternalStore(subscribeLaneWrite, laneWriting, () => false);
  const [error, setError] = useState('');
  const kind = holdKind(heldReason);
  const expiry = heldUntil ?? targets.data?.lanes.find(item => item.lane === lane)?.heldUntil ?? null;

  async function release() {
    if (!hold.hasHold || laneWriting()) return;
    setError('');
    setLaneWriting(true);
    try {
      await postReleaseHold(lane, 'reset detected');
      await Promise.all([
        refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true),
        refetchQuery(opsRunsQuery.key, () => opsRunsQuery.fetch(), true),
      ]);
    } catch (reason) { setError(readFailureReason(reason)); }
    finally { setLaneWriting(false); }
  }

  if (!kind) return null;
  if (kind === 'manual') return <span className={styles.muted} aria-disabled="true">{releaseLabel(kind, expiry, Date.now())}</span>;
  return <>
    <Button size="sm" disabled={!hold.hasHold || pending} onClick={() => void release()}>{releaseLabel(kind, expiry, Date.now())}</Button>
    {error ? <span className={styles.pauseError} role="status">{error}</span> : null}
  </>;
}
